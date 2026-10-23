/**
 * #931's acceptance: the degraded notice is emitted only for a REAL permission
 * failure, and says what failed.
 *
 * GitHub also answers HTTP 403 when a token is rate limited (primary limit:
 * `x-ratelimit-remaining: 0`; secondary limit: `retry-after`). The REST client
 * mapped every 403 to `GitHubPermissionError`, so a rate-limited run reported
 * "token lacks write permission on PR comments" -- sending the reader off to
 * fix a token that is fine.
 *
 * `fetch` is stubbed: no network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  RestGitHubClient,
  upsertStickyComment,
} from '../src/guardian/pr-comment.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(createResponse: () => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? createResponse()
        : new Response('[]', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
    ),
  );
}

/** The notice a degraded upsert reports, or the error text it threw. */
async function upsertOutcome(): Promise<string> {
  // #1467: a rate-limited 403 is now retried; the no-op sleep keeps the
  // retry (and a `retry-after: 60`) out of real time.
  const client = new RestGitHubClient(
    'owner/repo',
    1,
    'tok',
    undefined,
    async () => {},
  );
  return upsertStickyComment(client, '<!-- canary-pr-guardian -->\nbody').then(
    (r) => r.notice ?? r.action,
    (err: unknown) => String(err),
  );
}

describe('a rate-limited 403 is not reported as a permission failure', () => {
  it('primary rate limit (x-ratelimit-remaining: 0)', async () => {
    stubFetch(
      () =>
        new Response('{"message":"API rate limit exceeded"}', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0' },
        }),
    );
    expect(await upsertOutcome()).not.toContain('lacks write permission');
  });

  it('secondary rate limit (retry-after)', async () => {
    stubFetch(
      () =>
        new Response('{"message":"secondary rate limit"}', {
          status: 403,
          headers: { 'retry-after': '60' },
        }),
    );
    expect(await upsertOutcome()).not.toContain('lacks write permission');
  });

  it('a plain 403 still degrades as a permission failure', async () => {
    stubFetch(
      () =>
        new Response('{"message":"Resource not accessible by integration"}', {
          status: 403,
        }),
    );
    expect(await upsertOutcome()).toContain('lacks write permission');
  });
});
