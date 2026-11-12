/**
 * #1445: the guardian's comment client read `process.env['GITHUB_TOKEN']`
 * instead of the injected `deps.env`, and `RestGitHubClient` sent
 * `Authorization: Bearer ` with an empty value when no token was set, so the
 * post failed as a GitHub auth error rather than naming the missing
 * credential.
 *
 * Contract:
 * - `pr-check --post-comment` takes the token from `deps.env`, never from
 *   `process.env`.
 * - `RestGitHubClient` with an empty token never calls `fetch`; it rejects
 *   with an error naming GITHUB_TOKEN, and the sticky upsert degrades with a
 *   notice naming it (the verdict still reaches the log and step summary).
 *
 * `fetch` is stubbed (no network).
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

/** Stub `fetch` with an empty comment page / a created comment; returns its spy. */
function stubFetch(): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = (init?.method ?? 'GET') === 'GET' ? [] : { id: 1, body: '' };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

/** The Authorization header of every `fetch` call. */
function authHeaders(spy: ReturnType<typeof vi.fn>): string[] {
  return spy.mock.calls.map(([, init]) => {
    const headers = (init as RequestInit).headers as Record<string, string>;
    return headers['Authorization'] ?? '';
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RestGitHubClient rejects an empty token', () => {
  it('createComment and listComments reject naming GITHUB_TOKEN without calling fetch', async () => {
    const spy = stubFetch();
    const client = new RestGitHubClient('o/r', 7, '');
    await expect(client.createComment('hi')).rejects.toThrow(/GITHUB_TOKEN/);
    await expect(client.listComments()).rejects.toThrow(/GITHUB_TOKEN/);
    await expect(client.updateComment(1, 'hi')).rejects.toThrow(/GITHUB_TOKEN/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('the sticky upsert degrades with a notice naming GITHUB_TOKEN', async () => {
    const spy = stubFetch();
    const r = await upsertStickyComment(
      new RestGitHubClient('o/r', 7, ''),
      `${STICKY_MARKER}\nbody`,
    );
    expect(r).toMatchObject({ action: 'degraded', comment_id: null });
    expect(r.notice).toMatch(/^guardian: .*GITHUB_TOKEN/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('pr-check --post-comment reads the token from deps.env', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkTmp();
  });
  afterEach(() => {
    rmTmp(tmp);
  });

  // Coverage-blind run: the computed verdict is ABSTAINED (exit 3).
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

  /** Run with `depsEnv` injected while process.env holds a different token. */
  const prCheck = (depsEnv: Record<string, string>) =>
    invokeGuardian(['pr-check', '--diff', '-', '--post-comment'], {
      input: DIFF_NEW_UNIT,
      env: { GITHUB_TOKEN: 'process-env-token' },
      cwd: tmp,
      deps: {
        env: {
          GITHUB_REPOSITORY: 'o/r',
          GITHUB_REF: 'refs/pull/7/merge',
          ...depsEnv,
        },
      },
    });

  it('authenticates with the deps.env token, not the process.env one', async () => {
    const spy = stubFetch();
    const res = await prCheck({ GITHUB_TOKEN: 'deps-env-token' });
    expect(res.code).toBe(ABSTAINED);
    expect(spy).toHaveBeenCalled();
    expect(new Set(authHeaders(spy))).toEqual(
      new Set(['Bearer deps-env-token']),
    );
  });

  it('with no deps.env token it sends nothing, warns naming GITHUB_TOKEN, and keeps the verdict', async () => {
    const spy = stubFetch();
    const summary = join(tmp, 'step-summary.md');
    writeFileSync(summary, '');
    const res = await prCheck({ GITHUB_STEP_SUMMARY: summary });
    expect({
      fetched: spy.mock.calls.length,
      code: res.code,
      warned: /::warning::guardian: .*GITHUB_TOKEN/.test(res.stdout),
      log: res.stdout.includes('pkg/widget.py'),
      summary: readFileSync(summary, 'utf-8').includes('GITHUB_TOKEN'),
    }).toEqual({
      fetched: 0,
      code: ABSTAINED,
      warned: true,
      log: true,
      summary: true,
    });
  });
});
