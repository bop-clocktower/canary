/**
 * #1467: a transient GitHub 5xx while posting the sticky comment failed the
 * whole (required) guardian check. PR Guardian run 39985841183 computed its
 * verdict, then `RestGitHubClient.createComment` threw `GitHub API 500` and the
 * job exited 1; the re-run on the same SHA passed.
 *
 * Contract (human-decided F1-F3):
 * - F1: the retry lives in RestGitHubClient's request path, reads and writes.
 *   A non-idempotent POST is retried ONLY on a 429 or a rate-limited 403 (the
 *   request was rejected before processing); a 5xx may arrive after GitHub
 *   already created the comment, so re-POSTing would stack a second sticky.
 * - F3: 3 attempts, backoff 1s then 2s, `retry-after` honoured; 5xx, 429 and a
 *   rate-limited 403 retry; any other 4xx is loud and is NOT retried.
 * - F2: a post that still fails degrades to a `::warning::` and `pr-check`
 *   exits with the COMPUTED verdict's code.
 *
 * `fetch` is stubbed (no network) and `sleep` is injected (no real waiting).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RestGitHubClient,
  STICKY_MARKER,
  upsertStickyComment,
} from '../src/guardian/pr-comment.js';
import { invokeGuardian, mkTmp, rmTmp } from './guardian-cli-testkit.js';

type Reply = { status: number; headers?: Record<string, string> };

interface FetchLog {
  calls: { method: string; url: string }[];
}

/**
 * Stub `fetch`: GETs answer from `gets`, POSTs from `posts`, in order; the last
 * reply repeats once a list is exhausted. A 2xx POST echoes a comment row.
 */
function stubFetch(
  posts: Reply[],
  gets: Reply[] = [{ status: 200 }],
  patches: Reply[] = [{ status: 200 }],
): FetchLog {
  const log: FetchLog = { calls: [] };
  const queues: Record<string, Reply[]> = {
    GET: [...gets],
    POST: [...posts],
    PATCH: [...patches],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      log.calls.push({ method, url });
      const q = queues[method]!;
      const reply = q.length > 1 ? q.shift()! : q[0]!;
      const body =
        reply.status >= 300
          ? '{"message":"error"}'
          : method === 'GET'
            ? '[]'
            : '{"id":77,"body":"x"}';
      return new Response(body, {
        status: reply.status,
        headers: { 'content-type': 'application/json', ...reply.headers },
      });
    }),
  );
  return log;
}

function recordingSleep(): {
  sleeps: number[];
  sleep: (ms: number) => Promise<void>;
} {
  const sleeps: number[] = [];
  return { sleeps, sleep: async (ms: number) => void sleeps.push(ms) };
}

function client(sleep: (ms: number) => Promise<void>): RestGitHubClient {
  return new RestGitHubClient('owner/repo', 1, 'tok', undefined, sleep);
}

const posts = (log: FetchLog) => log.calls.filter((c) => c.method === 'POST');
const patches = (log: FetchLog) =>
  log.calls.filter((c) => c.method === 'PATCH');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RestGitHubClient retries transient failures (F1, F3)', () => {
  it('a 500 on the comment POST is NOT retried (it may already have posted)', async () => {
    const log = stubFetch([{ status: 500 }, { status: 201 }]);
    const { sleeps, sleep } = recordingSleep();
    await expect(client(sleep).createComment('body')).rejects.toThrow(
      /GitHub API 500/,
    );
    expect({ posts: posts(log).length, sleeps }).toEqual({
      posts: 1,
      sleeps: [],
    });
  });

  it('a 500 then a 200 on the comment PATCH succeeds after one 1s backoff', async () => {
    const log = stubFetch([], undefined, [{ status: 500 }, { status: 200 }]);
    const { sleeps, sleep } = recordingSleep();
    await client(sleep).updateComment(77, 'body');
    expect({ patches: patches(log).length, sleeps }).toEqual({
      patches: 2,
      sleeps: [1000],
    });
  });

  it('three 500s on the PATCH stop at 3 attempts with 1s then 2s backoff', async () => {
    const log = stubFetch([], undefined, [{ status: 500 }]);
    const { sleeps, sleep } = recordingSleep();
    await expect(client(sleep).updateComment(77, 'body')).rejects.toThrow(
      /GitHub API 500/,
    );
    expect({ patches: patches(log).length, sleeps }).toEqual({
      patches: 3,
      sleeps: [1000, 2000],
    });
  });

  it('a 429 honours retry-after (seconds) instead of the default backoff', async () => {
    const log = stubFetch([
      { status: 429, headers: { 'retry-after': '5' } },
      { status: 201 },
    ]);
    const { sleeps, sleep } = recordingSleep();
    await client(sleep).createComment('body');
    expect({ posts: posts(log).length, sleeps }).toEqual({
      posts: 2,
      sleeps: [5000],
    });
  });

  it('a rate-limited 403 is retried', async () => {
    const log = stubFetch([
      { status: 403, headers: { 'x-ratelimit-remaining': '0' } },
      { status: 201 },
    ]);
    const { sleep } = recordingSleep();
    await client(sleep).createComment('body');
    expect(posts(log)).toHaveLength(2);
  });

  it('a 404 is loud and NOT retried', async () => {
    const log = stubFetch([{ status: 404 }]);
    const { sleeps, sleep } = recordingSleep();
    await expect(client(sleep).createComment('body')).rejects.toThrow(
      /GitHub API 404/,
    );
    expect({ posts: posts(log).length, sleeps }).toEqual({
      posts: 1,
      sleeps: [],
    });
  });

  it('a plain (permission) 403 is NOT retried', async () => {
    const log = stubFetch([{ status: 403 }]);
    const { sleep } = recordingSleep();
    await expect(client(sleep).createComment('body')).rejects.toThrow(/403/);
    expect(posts(log)).toHaveLength(1);
  });

  it('the paged comment read retries a 502 too', async () => {
    const log = stubFetch(
      [{ status: 201 }],
      [{ status: 502 }, { status: 200 }],
    );
    const { sleeps, sleep } = recordingSleep();
    await expect(client(sleep).listComments()).resolves.toEqual([]);
    expect({
      gets: log.calls.filter((c) => c.method === 'GET').length,
      sleeps,
    }).toEqual({ gets: 2, sleeps: [1000] });
  });
});

describe('upsertStickyComment degrades a post that keeps failing (F2)', () => {
  it('three 500s degrade to a notice instead of throwing', async () => {
    stubFetch([{ status: 500 }]);
    const { sleep } = recordingSleep();
    const r = await upsertStickyComment(
      client(sleep),
      `${STICKY_MARKER}\nbody`,
    );
    expect(r).toMatchObject({ action: 'degraded', comment_id: null });
    expect(r.notice).toMatch(/HTTP 500/);
  });

  it('a 429 that never clears degrades as a rate limit', async () => {
    stubFetch([{ status: 429 }]);
    const { sleep } = recordingSleep();
    const r = await upsertStickyComment(
      client(sleep),
      `${STICKY_MARKER}\nbody`,
    );
    expect(r.notice).toMatch(/rate limit/);
  });

  it('a 404 still throws (other 4xx stay loud)', async () => {
    stubFetch([{ status: 404 }]);
    const { sleep } = recordingSleep();
    await expect(
      upsertStickyComment(client(sleep), `${STICKY_MARKER}\nbody`),
    ).rejects.toThrow(/GitHub API 404/);
  });
});

describe('pr-check --post-comment keeps the verdict when the post fails (F2)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkTmp();
  });
  afterEach(() => {
    rmTmp(tmp);
  });

  // Coverage-blind run: the computed verdict is ABSTAINED (exit 3), which is
  // distinct from the crash path's thrown error.
  const ABSTAINED = 3;
  const DIFF_NEW_UNIT = `diff --git a/pkg/widget.py b/pkg/widget.py
index 1111111..2222222 100644
--- a/pkg/widget.py
+++ b/pkg/widget.py
@@ -0,0 +1,3 @@
+def widget():
+    return 42
+
`;

  /** `pr-check --post-comment` on DIFF_NEW_UNIT through a stubbed client. */
  const prCheck = (
    sleep: (ms: number) => Promise<void>,
    env: Record<string, string> = {},
  ) =>
    invokeGuardian(['pr-check', '--diff', '-', '--post-comment'], {
      input: DIFF_NEW_UNIT,
      env: {
        GITHUB_REPOSITORY: 'o/r',
        GITHUB_REF: 'refs/pull/7/merge',
        ...env,
      },
      cwd: tmp,
      deps: {
        buildCommentClient: (repo, pr) =>
          new RestGitHubClient(repo, pr, 'tok', undefined, sleep),
      },
    });

  it('exits with the verdict code and warns when every POST is a 500', async () => {
    stubFetch([{ status: 500 }]);
    const { sleep } = recordingSleep();
    const res = await prCheck(sleep);
    expect(res.code).toBe(ABSTAINED);
    expect(res.stdout).toMatch(/::warning::guardian: .*HTTP 500/);
  });

  it('a POST 500 then 201 makes exactly ONE POST and degrades to the verdict code', async () => {
    const log = stubFetch([{ status: 500 }, { status: 201 }]);
    const { sleep } = recordingSleep();
    const res = await prCheck(sleep);
    expect({
      posts: posts(log).length,
      code: res.code,
      warned: /::warning::guardian: .*HTTP 500/.test(res.stdout),
    }).toEqual({ posts: 1, code: ABSTAINED, warned: true });
  });

  it('prints the verdict to the job log and step summary when the post degrades', async () => {
    stubFetch([{ status: 500 }]);
    const { sleep } = recordingSleep();
    const summary = join(tmp, 'step-summary.md');
    writeFileSync(summary, '');
    const res = await prCheck(sleep, { GITHUB_STEP_SUMMARY: summary });
    expect({
      log: res.stdout.includes('pkg/widget.py'),
      summary: readFileSync(summary, 'utf-8').includes('pkg/widget.py'),
    }).toEqual({ log: true, summary: true });
  });
});
