/**
 * Status mapping and bounded retry for the guardian's GitHub REST calls (#1467).
 *
 * A transient GitHub failure (a 5xx, a 429, or a rate-limited 403) says nothing
 * about the diff, yet a single one used to fail the required `guardian` check.
 * {@link fetchWithRetry} gives each request {@link MAX_ATTEMPTS} tries (a POST
 * only on a rate limit, never a 5xx); every other status is a real answer and
 * returns on the first try.
 * A network-level rejection (ECONNRESET, DNS, socket timeout) gets the same
 * tries on GET and PATCH, but never a re-sent POST (#1478), and surfaces as a
 * {@link GitHubNetworkError}.
 * {@link toGitHubError} then types a final failure so the sticky-comment upsert
 * can tell a token problem, a rate limit, and a GitHub outage apart. Split out
 * of `pr-comment.ts`, which owns the comment client and the degrade decision.
 */

/** Attempts per GitHub request (#1467 F3): the first try plus two retries. */
export const MAX_ATTEMPTS = 3;
/** Backoff before retry n is BASE * 2^(n-1): 1s, then 2s. */
const BASE_BACKOFF_MS = 1000;
/**
 * Ceiling on an honoured `retry-after`. A secondary rate limit can ask for
 * minutes; three of those would stall a required check far longer than the
 * comment is worth, and the post degrades to a warning anyway.
 */
const MAX_RETRY_AFTER_MS = 60_000;

/** Waits `ms`. Injected so retry tests never wait in real time. */
export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function isRateLimited(headers: Headers | undefined): boolean {
  return (
    headers?.get('x-ratelimit-remaining') === '0' ||
    (headers?.get('retry-after') ?? null) !== null
  );
}

/**
 * Worth another attempt (#1467 F3): a 5xx, a 429, or a RATE-LIMITED 403. Every
 * other 4xx is a real answer about the request and stays loud on the first try.
 *
 * A POST is not idempotent: a 5xx can arrive after GitHub already created the
 * comment, and re-POSTing would stack a second guardian sticky (SC-9). So a
 * POST retries only on a 429 or rate-limited 403, which GitHub rejects before
 * processing; a POST 5xx falls straight through to the caller's degrade path.
 */
function isRetryable(
  method: string,
  status: number,
  headers: Headers,
): boolean {
  if (status === 429 || (status === 403 && isRateLimited(headers))) return true;
  return status >= 500 && method !== 'POST';
}

/** `retry-after` (seconds) when GitHub sent one, else exponential backoff. */
function retryDelayMs(attempt: number, headers: Headers): number {
  const raw = headers.get('retry-after');
  const secs = raw === null ? NaN : Number(raw);
  if (Number.isFinite(secs) && secs >= 0) {
    return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
  }
  return BASE_BACKOFF_MS * 2 ** (attempt - 1);
}

/**
 * Error codes Node's `fetch` (undici) puts on `cause.code` when the request
 * never got an HTTP answer: a reset or refused socket, a DNS failure, or a
 * connect/socket timeout (#1478). Nothing else counts as a network error, so a
 * programming error that happens to be a TypeError still throws as-is.
 */
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/**
 * The network code behind a `fetch` rejection, else `null`. undici rejects with
 * `TypeError('fetch failed')` and the reason on `cause`; a dual-stack connect
 * failure nests per-address errors in an AggregateError's `errors`.
 */
function networkErrorCode(err: unknown): string | null {
  if (!(err instanceof TypeError)) return null;
  const cause: unknown = err.cause;
  for (const candidate of [cause, ...nestedErrors(cause)]) {
    const code = knownNetworkCode(candidate);
    if (code !== null) return code;
  }
  return null;
}

/** An AggregateError's per-attempt `errors`, else none. */
function nestedErrors(cause: unknown): unknown[] {
  const errors = (cause as { errors?: unknown } | null | undefined)?.errors;
  return Array.isArray(errors) ? errors : [];
}

/** `value.code` when it is one of {@link NETWORK_ERROR_CODES}, else `null`. */
function knownNetworkCode(value: unknown): string | null {
  const code = (value as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && NETWORK_ERROR_CODES.has(code)
    ? code
    : null;
}

/**
 * A request that never got an HTTP answer (#1478). Like a 5xx it says nothing
 * about the diff, so `upsertStickyComment` degrades it to a notice.
 */
export class GitHubNetworkError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'GitHubNetworkError';
  }
}

/**
 * `fetch` with the bounded retry (#1467): up to {@link MAX_ATTEMPTS} tries on a
 * retryable status (method-aware: see {@link isRetryable}). Returns the last
 * response either way, so the caller's status mapping still decides what a
 * final failure means.
 *
 * A network rejection (#1478) is retried with the same backoff on GET and
 * PATCH. A POST is never re-sent after one: the request may already have
 * landed, and a second POST would stack a second sticky (SC-9). Either way the
 * final network failure throws a {@link GitHubNetworkError}; any other
 * rejection is rethrown untouched.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  sleep: Sleep,
): Promise<Response> {
  const method = init.method ?? 'GET';
  for (let attempt = 1; ; attempt += 1) {
    let resp: Response;
    try {
      resp = await fetch(url, init);
    } catch (err) {
      const code = networkErrorCode(err);
      if (code === null) throw err;
      if (method === 'POST' || attempt >= MAX_ATTEMPTS) {
        throw new GitHubNetworkError(
          `GitHub API network error (${code}): ${method} ${url}`,
          code,
          { cause: err },
        );
      }
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
      continue;
    }
    if (
      resp.ok ||
      attempt >= MAX_ATTEMPTS ||
      !isRetryable(method, resp.status, resp.headers)
    ) {
      return resp;
    }
    // Release the discarded body so the connection is reusable.
    await resp.body?.cancel();
    await sleep(retryDelayMs(attempt, resp.headers));
  }
}

/**
 * A client cannot write (fork read-only token → HTTP 403).
 *
 * Thrown by write methods so `upsertStickyComment` can degrade loudly to
 * a `::warning::` annotation instead of crashing the job (OT-4).
 */
export class GitHubPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubPermissionError';
  }
}

/**
 * GitHub also answers 403 to a RATE-LIMITED token (primary limit:
 * `x-ratelimit-remaining: 0`; secondary limit: `retry-after`). That is not a
 * permission failure, and reporting it as one sends the reader off to fix a
 * token that is fine (#931: the notice must say what failed).
 */
export class GitHubRateLimitError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GitHubRateLimitError';
  }
}

/**
 * A 5xx that outlived every retry (#1467). It is infrastructure, not a verdict
 * on the diff, so `upsertStickyComment` degrades it to a notice rather
 * than letting it replace the computed exit code.
 */
export class GitHubServerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GitHubServerError';
  }
}

/**
 * Map a non-2xx status to an error: a non-rate-limit 403 is a permission
 * error, a 429 or rate-limited 403 a rate limit, a 5xx a server error.
 */
export function toGitHubError(
  status: number,
  url: string,
  headers?: Headers,
): Error {
  if (status >= 500) {
    return new GitHubServerError(`GitHub API ${status}: ${url}`, status);
  }
  if (status === 429) {
    return new GitHubRateLimitError(
      `GitHub API 429 (rate limited): ${url}`,
      429,
    );
  }
  if (status !== 403) return new Error(`GitHub API ${status}: ${url}`);
  return isRateLimited(headers)
    ? new GitHubRateLimitError(`GitHub API 403 (rate limited): ${url}`, 403)
    : new GitHubPermissionError(
        `GitHub API 403 (read-only token / fork PR?): ${url}`,
      );
}
