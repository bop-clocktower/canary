/**
 * Status mapping and bounded retry for the guardian's GitHub REST calls (#1467).
 *
 * A transient GitHub failure (a 5xx, a 429, or a rate-limited 403) says nothing
 * about the diff, yet a single one used to fail the required `guardian` check.
 * {@link fetchWithRetry} gives each request {@link MAX_ATTEMPTS} tries; every
 * other status is a real answer and returns on the first try.
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
 */
function isRetryable(status: number, headers: Headers): boolean {
  return (
    status >= 500 ||
    status === 429 ||
    (status === 403 && isRateLimited(headers))
  );
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
 * `fetch` with the bounded retry (#1467): up to {@link MAX_ATTEMPTS} tries on a
 * retryable status. Returns the last response either way, so the caller's
 * status mapping still decides what a final failure means.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  sleep: Sleep,
): Promise<Response> {
  for (let attempt = 1; ; attempt += 1) {
    const resp = await fetch(url, init);
    if (
      resp.ok ||
      attempt >= MAX_ATTEMPTS ||
      !isRetryable(resp.status, resp.headers)
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
