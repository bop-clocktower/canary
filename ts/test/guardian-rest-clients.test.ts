/**
 * Real-client tests for the guardian GitHub seams — these drive
 * {@link RestGitHubClient} and {@link RestBranchProtectionClient} against a
 * mocked global `fetch`, exercising the network paths the fakes only *model*.
 *
 * Why this matters: the fakes are a reimplementation of the real clients'
 * observable behavior (403 mapping, the 404 unprotected-vs-protected
 * disambiguation, create-vs-PATCH). Testing only the fakes would let the real
 * client drift undetected. These tests pin the real clients' URL/method/body
 * construction and error mapping so a divergence fails loudly.
 *
 * No network: `globalThis.fetch` is stubbed per-call with Response-like objects
 * and restored after each test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RestGitHubClient,
  GitHubPermissionError,
  upsertStickyComment,
} from '../src/guardian/pr-comment.js';
import {
  HttpError,
  RestBranchProtectionClient,
} from '../src/guardian/hard-gate.js';

/**
 * A minimal `Response`-like stub carrying `json()`, `text()`, and `headers`.
 *
 * `headers` is not optional: a real `Response` always has it, and the paged
 * read path (#528) reads `Link` off it. A stub without one models a response
 * that cannot exist and would hide a null-header crash.
 */
interface ResponseLike {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get: (name: string) => string | null };
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

/** Case-insensitive header lookup over a plain record, as `Headers` does. */
function headersOf(rows: Record<string, string>): ResponseLike['headers'] {
  const lower = new Map(
    Object.entries(rows).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return { get: (name) => lower.get(name.toLowerCase()) ?? null };
}

/**
 * A 2xx response whose body decodes to `body` via both `json()` and `text()`.
 * `nextUrl` sets a `Link: <...>; rel="next"` header, as GitHub does when the
 * result spans pages.
 */
function ok(body: unknown, status = 200, nextUrl?: string): ResponseLike {
  const raw = JSON.stringify(body);
  return {
    ok: true,
    status,
    statusText: 'OK',
    headers: headersOf(
      nextUrl === undefined ? {} : { Link: `<${nextUrl}>; rel="next"` },
    ),
    json: async () => body,
    text: async () => raw,
  };
}

/** A non-2xx response (empty body) with an explicit `status`/`statusText`. */
function fail(status: number, statusText = ''): ResponseLike {
  return {
    ok: false,
    status,
    statusText,
    headers: headersOf({}),
    json: async () => ({}),
    text: async () => '',
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The `[url, init]` args of the n-th `fetch` call. */
function call(n: number): [string, RequestInit] {
  const args = fetchMock.mock.calls[n] as [string, RequestInit];
  return args;
}

// ---------------------------------------------------------------------------
// RestGitHubClient (pr-comment)
// ---------------------------------------------------------------------------

describe('RestGitHubClient', () => {
  const client = (): RestGitHubClient =>
    new RestGitHubClient('owner/repo', 42, 'tok');

  it('listComments GETs the issues comments endpoint, asking for 100', async () => {
    fetchMock.mockResolvedValueOnce(ok([{ id: 1, body: 'a' }]));
    const rows = await client().listComments();
    expect(rows).toEqual([{ id: 1, body: 'a' }]);
    const [url, init] = call(0);
    // #528: `per_page` is the cheap floor under the Link-following loop.
    // Without it GitHub serves 30 and says nothing about the rest.
    expect(url).toBe(
      'https://api.github.com/repos/owner/repo/issues/42/comments?per_page=100',
    );
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok');
    expect(headers['Accept']).toBe('application/vnd.github+json');
    expect(headers['User-Agent']).toBe('canary-pr-guardian');
  });

  it('listComments coerces a non-array body to []', async () => {
    fetchMock.mockResolvedValueOnce(ok({ not: 'a list' }));
    expect(await client().listComments()).toEqual([]);
  });

  it('listComments follows Link rel="next" to the last page (#528)', async () => {
    // The regression: guardian's sticky comment sat on page 2 of a busy PR,
    // so `findSticky` missed it and guardian posted a SECOND sticky comment
    // while recording no adjudication. Nothing in the output said "partial".
    const page2 =
      'https://api.github.com/repos/owner/repo/issues/42/comments?per_page=100&page=2';
    fetchMock
      .mockResolvedValueOnce(
        ok(
          Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: 'x' })),
          200,
          page2,
        ),
      )
      .mockResolvedValueOnce(ok([{ id: 101, body: 'the sticky' }]));

    const rows = await client().listComments();
    expect(rows).toHaveLength(101);
    expect(rows.at(-1)).toEqual({ id: 101, body: 'the sticky' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(call(1)[0]).toBe(page2);
  });

  it('createComment POSTs the body to the issues endpoint', async () => {
    fetchMock.mockResolvedValueOnce(ok({ id: 5, body: 'hello' }));
    const row = await client().createComment('hello');
    expect(row).toEqual({ id: 5, body: 'hello' });
    const [url, init] = call(0);
    expect(url).toBe(
      'https://api.github.com/repos/owner/repo/issues/42/comments',
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ body: 'hello' });
  });

  it('updateComment PATCHes the comment-by-id endpoint', async () => {
    fetchMock.mockResolvedValueOnce(ok({ id: 7, body: 'new' }));
    const row = await client().updateComment(7, 'new');
    expect(row).toEqual({ id: 7, body: 'new' });
    const [url, init] = call(0);
    expect(url).toBe(
      'https://api.github.com/repos/owner/repo/issues/comments/7',
    );
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ body: 'new' });
  });

  it('a 403 maps to GitHubPermissionError', async () => {
    fetchMock.mockResolvedValueOnce(fail(403, 'Forbidden'));
    await expect(client().createComment('x')).rejects.toBeInstanceOf(
      GitHubPermissionError,
    );
  });

  it('a 403 on the PAGED read maps the same way as on a write (#528)', async () => {
    // The read and write paths took different code after #528; both must map
    // 403 identically or a fork PR would crash on read and degrade on write.
    fetchMock.mockResolvedValueOnce(fail(403, 'Forbidden'));
    await expect(client().listComments()).rejects.toBeInstanceOf(
      GitHubPermissionError,
    );
  });

  it('a 403 on page TWO fails loudly rather than returning page one', async () => {
    // The whole point of #528: a partial read must never look like a whole one.
    const page2 =
      'https://api.github.com/repos/owner/repo/issues/42/comments?per_page=100&page=2';
    fetchMock
      .mockResolvedValueOnce(ok([{ id: 1, body: 'a' }], 200, page2))
      .mockResolvedValueOnce(fail(403, 'Forbidden'));
    await expect(client().listComments()).rejects.toBeInstanceOf(
      GitHubPermissionError,
    );
  });

  it('a non-403 non-2xx propagates as a generic Error (not permission)', async () => {
    fetchMock.mockResolvedValueOnce(fail(500, 'Server Error'));
    const err = await client()
      .listComments()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(GitHubPermissionError);
  });

  it('upsertStickyComment drives the REAL client — create path', async () => {
    fetchMock
      .mockResolvedValueOnce(ok([])) // listComments → no sticky
      .mockResolvedValueOnce(ok({ id: 100, body: 'marker body' })); // createComment
    const result = await upsertStickyComment(client(), 'marker body');
    expect(result.action).toBe('created');
    expect(result.comment_id).toBe(100);
    expect(call(1)[1].method).toBe('POST');
  });

  it('upsertStickyComment drives the REAL client — update-existing path', async () => {
    const marked = '<!-- canary-pr-guardian -->\nold';
    fetchMock
      .mockResolvedValueOnce(ok([{ id: 9, body: marked }])) // listComments → sticky
      .mockResolvedValueOnce(ok({ id: 9, body: 'updated' })); // updateComment
    const result = await upsertStickyComment(client(), 'updated');
    expect(result.action).toBe('updated');
    expect(result.comment_id).toBe(9);
    const [url, init] = call(1);
    expect(url).toBe(
      'https://api.github.com/repos/owner/repo/issues/comments/9',
    );
    expect(init.method).toBe('PATCH');
  });
});

// ---------------------------------------------------------------------------
// RestBranchProtectionClient (hard-gate)
// ---------------------------------------------------------------------------

describe('RestBranchProtectionClient', () => {
  const client = (): RestBranchProtectionClient =>
    new RestBranchProtectionClient('owner/repo', 'tok');

  it('requiredCheckContexts returns contexts from a 200 checks payload', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({ checks: [{ context: 'build' }, { context: 'guardian' }] }),
    );
    expect(await client().requiredCheckContexts('main')).toEqual([
      'build',
      'guardian',
    ]);
    const [url, init] = call(0);
    expect(url).toBe(
      'https://api.github.com/repos/owner/repo/branches/main/protection/required_status_checks',
    );
    expect(init.method).toBe('GET');
  });

  it('requiredCheckContexts reads the legacy `contexts` shape', async () => {
    fetchMock.mockResolvedValueOnce(ok({ contexts: ['legacy'] }));
    expect(await client().requiredCheckContexts('main')).toEqual(['legacy']);
  });

  it('404 + parent /protection 200 → [] (protected-without-checks: PATCH path)', async () => {
    fetchMock
      .mockResolvedValueOnce(fail(404)) // required_status_checks → 404
      .mockResolvedValueOnce(ok({ url: 'x' })); // parent /protection → 200 (protected)
    expect(await client().requiredCheckContexts('main')).toEqual([]);
    expect(call(1)[0]).toBe(
      'https://api.github.com/repos/owner/repo/branches/main/protection',
    );
  });

  it('404 + parent /protection 404 → null (genuinely unprotected: create path)', async () => {
    fetchMock
      .mockResolvedValueOnce(fail(404)) // required_status_checks → 404
      .mockResolvedValueOnce(fail(404)); // parent /protection → 404 (unprotected)
    expect(await client().requiredCheckContexts('main')).toBeNull();
  });

  it('requiredCheckContexts maps 403 to GitHubPermissionError', async () => {
    fetchMock.mockResolvedValueOnce(fail(403, 'Forbidden'));
    await expect(client().requiredCheckContexts('main')).rejects.toBeInstanceOf(
      GitHubPermissionError,
    );
  });

  it('observedCheckContexts parses + sorts check-run names', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({
        check_runs: [{ name: 'guardian' }, { name: 'build' }, { name: '' }],
      }),
    );
    expect(await client().observedCheckContexts('main')).toEqual([
      'build',
      'guardian',
    ]);
    expect(call(0)[0]).toBe(
      'https://api.github.com/repos/owner/repo/commits/main/check-runs',
    );
  });

  it('observedCheckContexts degrades to [] on error', async () => {
    fetchMock.mockResolvedValueOnce(fail(500));
    expect(await client().observedCheckContexts('main')).toEqual([]);
  });

  it('observedCheckContexts returns [] when check_runs is not a list', async () => {
    fetchMock.mockResolvedValueOnce(ok({ check_runs: 'nope' }));
    expect(await client().observedCheckContexts('main')).toEqual([]);
  });

  it('setRequiredChecks create=true PUTs a fresh minimal ruleset', async () => {
    fetchMock.mockResolvedValueOnce(ok({}));
    await client().setRequiredChecks('main', ['guardian'], true);
    const [url, init] = call(0);
    expect(url).toBe(
      'https://api.github.com/repos/owner/repo/branches/main/protection',
    );
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({
      required_status_checks: {
        strict: false,
        checks: [{ context: 'guardian' }],
      },
      enforce_admins: null,
      required_pull_request_reviews: null,
      restrictions: null,
    });
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('setRequiredChecks create=false PATCHes only the checks sub-resource', async () => {
    fetchMock.mockResolvedValueOnce(ok({}));
    await client().setRequiredChecks('main', ['build', 'guardian'], false);
    const [url, init] = call(0);
    expect(url).toBe(
      'https://api.github.com/repos/owner/repo/branches/main/protection/required_status_checks',
    );
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({
      checks: [{ context: 'build' }, { context: 'guardian' }],
    });
  });

  it('setRequiredChecks maps 401 to GitHubPermissionError', async () => {
    fetchMock.mockResolvedValueOnce(fail(401, 'Unauthorized'));
    await expect(
      client().setRequiredChecks('main', ['guardian'], false),
    ).rejects.toBeInstanceOf(GitHubPermissionError);
  });

  it('a 404 on a non-disambiguated call throws HttpError carrying .status', async () => {
    fetchMock.mockResolvedValueOnce(fail(404, 'Not Found'));
    const err = await client()
      .setRequiredChecks('main', ['guardian'], false)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
  });
});
