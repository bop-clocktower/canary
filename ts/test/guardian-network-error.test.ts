/**
 * #1478: a network-level `fetch` failure (ECONNRESET, DNS, socket timeout)
 * while posting the sticky comment still failed the required `guardian` check.
 * #1470 retried and degraded HTTP 5xx/429, but Node's `fetch` REJECTS on a
 * network error (`TypeError: fetch failed`, the reason on `cause.code`), so it
 * never reached the status-based retry or the degrade branch.
 *
 * Contract (human-decided F2 = a):
 * - GET and PATCH retry a network error with the existing 1s/2s backoff.
 * - The comment-create POST is NEVER re-sent after a network error: the
 *   request may already have landed, and a re-POST would stack a second sticky.
 * - After retries the post degrades: `pr-check` exits with the computed
 *   verdict's code, prints a `::warning::`, and writes the verdict to the log
 *   and the step summary.
 * - Only network errors (classified on `cause.code`) are treated this way; any
 *   other thrown error, including a non-network TypeError, stays loud.
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

/** A status reply, a network rejection with `cause.code`, or a bug-shaped throw. */
type Step = number | { net: string; nested?: boolean } | 'bug';

/**
 * What undici throws for a network failure: `TypeError` + coded `cause`. With
 * `nested`, the code sits on an AggregateError's `errors` (dual-stack connect).
 */
function networkError(code: string, nested = false): TypeError {
  const coded = Object.assign(new Error(`connect ${code}`), { code });
  const cause = nested ? new AggregateError([coded], 'connect failed') : coded;
  return new TypeError('fetch failed', { cause });
}

/**
 * Stub `fetch` per method; each queue plays in order and its last step repeats.
 * Returns the method of every call made.
 */
function stubFetch(queues: Partial<Record<string, Step[]>>): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push(method);
      return play(nextStep(queues[method] ?? [200]), method);
    }),
  );
  return calls;
}

/** The queue's next step; the last one repeats once the rest are used up. */
function nextStep(queue: Step[]): Step {
  return queue.length > 1 ? queue.shift()! : queue[0]!;
}

/** Throw the step's error, or answer with its status. */
function play(step: Step, method: string): Response {
  if (step === 'bug') {
    throw new TypeError("Cannot read properties of undefined (reading 'x')");
  }
  if (typeof step === 'object') throw networkError(step.net, step.nested);
  return new Response(replyBody(step, method), {
    status: step,
    headers: { 'content-type': 'application/json' },
  });
}

/** An error body, an empty comment page (GET), or a comment row (writes). */
function replyBody(status: number, method: string): string {
  if (status >= 300) return '{"message":"error"}';
  return method === 'GET' ? '[]' : '{"id":77,"body":"x"}';
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

const count = (calls: string[], method: string) =>
  calls.filter((m) => m === method).length;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RestGitHubClient retries network errors on GET and PATCH', () => {
  it('the paged GET retries an ECONNRESET, then succeeds after one 1s backoff', async () => {
    const calls = stubFetch({ GET: [{ net: 'ECONNRESET' }, 200] });
    const { sleeps, sleep } = recordingSleep();
    await expect(client(sleep).listComments()).resolves.toEqual([]);
    expect({ gets: count(calls, 'GET'), sleeps }).toEqual({
      gets: 2,
      sleeps: [1000],
    });
  });

  it.each([
    'ENOTFOUND',
    'EAI_AGAIN',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
  ])('the PATCH retries a %s', async (code) => {
    const calls = stubFetch({ PATCH: [{ net: code }, 200] });
    const { sleeps, sleep } = recordingSleep();
    await client(sleep).updateComment(77, 'body');
    expect({ patches: count(calls, 'PATCH'), sleeps }).toEqual({
      patches: 2,
      sleeps: [1000],
    });
  });

  it('the PATCH retries a code nested in an AggregateError cause', async () => {
    const calls = stubFetch({
      PATCH: [{ net: 'ECONNREFUSED', nested: true }, 200],
    });
    const { sleeps, sleep } = recordingSleep();
    await client(sleep).updateComment(77, 'body');
    expect({ patches: count(calls, 'PATCH'), sleeps }).toEqual({
      patches: 2,
      sleeps: [1000],
    });
  });

  it('a PATCH that keeps resetting stops at 3 attempts with 1s then 2s backoff', async () => {
    const calls = stubFetch({ PATCH: [{ net: 'ECONNRESET' }] });
    const { sleeps, sleep } = recordingSleep();
    await expect(client(sleep).updateComment(77, 'body')).rejects.toThrow(
      /ECONNRESET/,
    );
    expect({ patches: count(calls, 'PATCH'), sleeps }).toEqual({
      patches: 3,
      sleeps: [1000, 2000],
    });
  });

  it('the comment POST is NOT re-sent after a network error', async () => {
    const calls = stubFetch({ POST: [{ net: 'ECONNRESET' }, 201] });
    const { sleeps, sleep } = recordingSleep();
    await expect(client(sleep).createComment('body')).rejects.toThrow(
      /ECONNRESET/,
    );
    expect({ posts: count(calls, 'POST'), sleeps }).toEqual({
      posts: 1,
      sleeps: [],
    });
  });

  it('a non-network TypeError is NOT retried and still throws as-is', async () => {
    const calls = stubFetch({ PATCH: ['bug', 200] });
    const { sleeps, sleep } = recordingSleep();
    await expect(client(sleep).updateComment(77, 'body')).rejects.toThrow(
      /Cannot read properties/,
    );
    expect({ patches: count(calls, 'PATCH'), sleeps }).toEqual({
      patches: 1,
      sleeps: [],
    });
  });
});

describe('upsertStickyComment degrades a network failure', () => {
  it('a POST network error degrades to a notice after exactly one POST', async () => {
    const calls = stubFetch({ POST: [{ net: 'ECONNRESET' }, 201] });
    const { sleep } = recordingSleep();
    const r = await upsertStickyComment(
      client(sleep),
      `${STICKY_MARKER}\nbody`,
    );
    expect({ posts: count(calls, 'POST'), action: r.action }).toEqual({
      posts: 1,
      action: 'degraded',
    });
    expect(r.notice).toMatch(/network error \(ECONNRESET\)/);
  });

  it('a GET that never connects degrades too', async () => {
    stubFetch({ GET: [{ net: 'ENOTFOUND' }] });
    const { sleep } = recordingSleep();
    const r = await upsertStickyComment(
      client(sleep),
      `${STICKY_MARKER}\nbody`,
    );
    expect(r).toMatchObject({ action: 'degraded', comment_id: null });
    expect(r.notice).toMatch(/ENOTFOUND/);
  });

  it('a non-network TypeError still throws (a bug stays loud)', async () => {
    stubFetch({ GET: ['bug'] });
    const { sleep } = recordingSleep();
    await expect(
      upsertStickyComment(client(sleep), `${STICKY_MARKER}\nbody`),
    ).rejects.toThrow(/Cannot read properties/);
  });
});

describe('pr-check --post-comment keeps the verdict on a network failure', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkTmp();
  });
  afterEach(() => {
    rmTmp(tmp);
  });

  // Coverage-blind run: the computed verdict is ABSTAINED (exit 3), which is
  // distinct from the crash path's thrown error (exit 1).
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

  it('a POST ECONNRESET makes ONE POST, exits with the verdict, and warns', async () => {
    const calls = stubFetch({ POST: [{ net: 'ECONNRESET' }, 201] });
    const { sleep } = recordingSleep();
    const summary = join(tmp, 'step-summary.md');
    writeFileSync(summary, '');
    const res = await prCheck(sleep, { GITHUB_STEP_SUMMARY: summary });
    expect({
      posts: count(calls, 'POST'),
      code: res.code,
      warned: /::warning::guardian: .*ECONNRESET/.test(res.stdout),
      log: res.stdout.includes('pkg/widget.py'),
      summary: readFileSync(summary, 'utf-8').includes('pkg/widget.py'),
    }).toEqual({
      posts: 1,
      code: ABSTAINED,
      warned: true,
      log: true,
      summary: true,
    });
  });
});
