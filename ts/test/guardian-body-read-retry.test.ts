/**
 * #1503: `fetch` resolves once the headers arrive, so a socket reset or
 * `UND_ERR_BODY_TIMEOUT` while READING the body (`resp.json()`) used to escape
 * the retry classifier as a bare `TypeError('terminated')` and fail the run.
 *
 * Contract:
 * - S1: a body-read network error is classified like a `fetch` rejection. A GET
 *   (the paged comment read) retries it with the same backoff; a write is never
 *   re-sent for it (the request already landed) but still surfaces as a
 *   `GitHubNetworkError`, so the sticky upsert degrades instead of crashing.
 * - S2: a non-network rejection (an `AbortError`) is rethrown unchanged, after
 *   exactly one `fetch` and no sleep.
 * - S3: the network-error notice says the comment MAY not have been posted:
 *   a POST that lost its response may have created it.
 *
 * `fetch` is stubbed and `sleep` injected: no network, no real waiting.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GitHubNetworkError,
  readWithRetry,
} from '../src/guardian/github-http.js';
import {
  RestGitHubClient,
  STICKY_MARKER,
  upsertStickyComment,
} from '../src/guardian/pr-comment.js';

/** What undici raises when the body stream dies: `TypeError` + coded cause. */
function bodyError(code: string): TypeError {
  const cause = Object.assign(new Error(`body ${code}`), { code });
  return new TypeError('terminated', { cause });
}

/** A step: a good reply, or a 200 whose body read throws `err`. */
type Step = 'ok' | { bodyThrows: Error };

/** A 200 response whose `json()` either answers or rejects. */
function reply(step: Step, method: string): Response {
  const json = async (): Promise<unknown> => {
    if (step !== 'ok') throw step.bodyThrows;
    return method === 'GET' ? [] : { id: 77, body: 'x' };
  };
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    body: null,
    json,
  } as unknown as Response;
}

/** Stub `fetch` per method; the last step of each queue repeats. */
function stubFetch(queues: Partial<Record<string, Step[]>>): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push(method);
      const queue = queues[method] ?? ['ok'];
      return reply(queue.length > 1 ? queue.shift()! : queue[0]!, method);
    }),
  );
  return calls;
}

function recordingSleep(): {
  sleeps: number[];
  sleep: (ms: number) => Promise<void>;
} {
  const sleeps: number[] = [];
  return { sleeps, sleep: async (ms: number) => void sleeps.push(ms) };
}

const client = (sleep: (ms: number) => Promise<void>) =>
  new RestGitHubClient('owner/repo', 1, 'tok', undefined, sleep);

const count = (calls: string[], method: string) =>
  calls.filter((m) => m === method).length;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('S1: a body-read network error goes through the retry classifier', () => {
  it('the paged GET retries a body reset, then succeeds after one 1s backoff', async () => {
    const calls = stubFetch({
      GET: [{ bodyThrows: bodyError('UND_ERR_SOCKET') }, 'ok'],
    });
    const { sleeps, sleep } = recordingSleep();
    await expect(client(sleep).listComments()).resolves.toEqual([]);
    expect({ gets: count(calls, 'GET'), sleeps }).toEqual({
      gets: 2,
      sleeps: [1000],
    });
  });

  it('a GET body that keeps timing out stops at 3 attempts as a network error', async () => {
    const calls = stubFetch({
      GET: [{ bodyThrows: bodyError('UND_ERR_BODY_TIMEOUT') }],
    });
    const { sleeps, sleep } = recordingSleep();
    const err = await client(sleep)
      .listComments()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubNetworkError);
    expect((err as GitHubNetworkError).code).toBe('UND_ERR_BODY_TIMEOUT');
    expect({ gets: count(calls, 'GET'), sleeps }).toEqual({
      gets: 3,
      sleeps: [1000, 2000],
    });
  });

  it.each(['POST', 'PATCH'])(
    'a %s body-read reset is NOT re-sent but is typed as a network error',
    async (method) => {
      const calls = stubFetch({
        [method]: [{ bodyThrows: bodyError('ECONNRESET') }, 'ok'],
      });
      const { sleeps, sleep } = recordingSleep();
      const c = client(sleep);
      const err = await (
        method === 'POST' ? c.createComment('b') : c.updateComment(77, 'b')
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GitHubNetworkError);
      expect({ sent: count(calls, method), sleeps }).toEqual({
        sent: 1,
        sleeps: [],
      });
    },
  );

  it('a non-network body error (bad JSON) is not retried and throws as-is', async () => {
    const bad = new SyntaxError('Unexpected token < in JSON');
    const calls = stubFetch({ GET: [{ bodyThrows: bad }, 'ok'] });
    const { sleeps, sleep } = recordingSleep();
    await expect(client(sleep).listComments()).rejects.toBe(bad);
    expect({ gets: count(calls, 'GET'), sleeps }).toEqual({
      gets: 1,
      sleeps: [],
    });
  });

  it('the sticky upsert degrades a POST body-read reset after one POST', async () => {
    const calls = stubFetch({
      POST: [{ bodyThrows: bodyError('ECONNRESET') }],
    });
    const { sleep } = recordingSleep();
    const r = await upsertStickyComment(
      client(sleep),
      `${STICKY_MARKER}\nbody`,
    );
    expect({ posts: count(calls, 'POST'), action: r.action }).toEqual({
      posts: 1,
      action: 'degraded',
    });
  });
});

describe('S2: a non-network rejection is rethrown unchanged', () => {
  it('an AbortError: same object, one fetch, no sleep', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    const fetchMock = vi.fn(async () => {
      throw abort;
    });
    vi.stubGlobal('fetch', fetchMock);
    const { sleeps, sleep } = recordingSleep();
    await expect(
      readWithRetry(
        'https://api.github.com/x',
        { method: 'GET' },
        sleep,
        async (r) => r,
      ),
    ).rejects.toBe(abort);
    expect({ fetches: fetchMock.mock.calls.length, sleeps }).toEqual({
      fetches: 1,
      sleeps: [],
    });
  });
});

describe('S3: the network notice does not overclaim', () => {
  it('says the findings may not have been posted', async () => {
    stubFetch({ POST: [{ bodyThrows: bodyError('ECONNRESET') }] });
    const { sleep } = recordingSleep();
    const r = await upsertStickyComment(
      client(sleep),
      `${STICKY_MARKER}\nbody`,
    );
    expect(r.notice).toMatch(/network error \(ECONNRESET\)/);
    expect(r.notice).toMatch(/may not have been posted/);
    expect(r.notice).not.toMatch(/findings not posted/);
  });
});
