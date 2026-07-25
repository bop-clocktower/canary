/**
 * Deterministic GitHub PR comment poster (Tier 0, agent-free).
 *
 * Faithful TypeScript port of `agent/guardian/pr_comment.py`.
 *
 * This module posts/updates the single sticky guardian findings comment on a
 * pull request. It is **deterministic HTTP behind an interface seam** — it
 * imports no agent/LLM module (SC-11).
 *
 * Design:
 *
 * - {@link GitHubClient} is the seam every consumer talks to
 *   (`listComments` / `createComment` / `updateComment`).
 * - {@link FakeGitHubClient} is the in-memory implementation used by every unit
 *   test — **no network**. It can simulate a fork read-only token via
 *   `deny_writes=true` (writes reject with {@link GitHubPermissionError}).
 * - {@link RestGitHubClient} (Python's private `_RestGitHubClient`) is the thin
 *   real client. Network lives **only** here and is never exercised in unit
 *   tests.
 *
 * Python→TS nuances:
 *   - **async**: Python's `urllib` client is synchronous; Node's global `fetch`
 *     is async. The seam methods are therefore `Promise`-returning, so the
 *     real client can `await fetch`. The fakes satisfy the async interface by
 *     being `async` (returning already-resolved values), and
 *     {@link upsertStickyComment} becomes `async`. The pure helpers
 *     ({@link findSticky}, {@link degradationAnnotation}) stay synchronous.
 *   - **error mapping**: `fetch` resolves (does not throw) on a 4xx/5xx status,
 *     so the 403→{@link GitHubPermissionError} mapping is done off `resp.status`
 *     rather than off a raised `HTTPError`. As in the oracle, ONLY 403 maps to a
 *     permission error here; any other non-2xx propagates as a generic error.
 */

// Single source of truth for the sticky-comment marker. `pr_check.render`
// emits the identical literal at the head of a `comment`-format body so
// `findSticky` can locate the guardian comment for in-place upsert.
export const STICKY_MARKER = '<!-- canary-pr-guardian -->';

/** A GitHub issue comment row: `{ id, body }`. */
export interface Comment {
  id: number;
  body: string;
}

/** The comment-poster seam. Every consumer depends on this, not on HTTP. */
export interface GitHubClient {
  /** Return the PR's issue comments as `[{ id, body }, ...]`. */
  listComments(): Promise<Comment[]>;
  /** Create a new comment; return `{ id, body }`. */
  createComment(body: string): Promise<Comment>;
  /** Update an existing comment in place; return the updated row. */
  updateComment(commentId: number, body: string): Promise<Comment>;
}

/**
 * A client cannot write (fork read-only token → HTTP 403).
 *
 * Thrown by write methods so {@link upsertStickyComment} can degrade loudly to
 * a `::warning::` annotation instead of crashing the job (OT-4).
 */
export class GitHubPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubPermissionError';
  }
}

/**
 * In-memory {@link GitHubClient} for unit tests — no network.
 *
 * Seed `comments` to model existing PR comments. Set `deny_writes=true` to
 * simulate a fork read-only token: `createComment`/`updateComment` then reject
 * with {@link GitHubPermissionError}.
 */
export class FakeGitHubClient implements GitHubClient {
  comments: Comment[];
  deny_writes: boolean;
  private nextId: number;

  constructor(init: { comments?: Comment[]; deny_writes?: boolean } = {}) {
    this.comments = init.comments ?? [];
    this.deny_writes = init.deny_writes ?? false;
    this.nextId = 1000;
  }

  async listComments(): Promise<Comment[]> {
    return this.comments;
  }

  async createComment(body: string): Promise<Comment> {
    if (this.deny_writes) {
      throw new GitHubPermissionError('read-only token: cannot create comment');
    }
    this.nextId += 1;
    const row: Comment = { id: this.nextId, body };
    this.comments.push(row);
    return row;
  }

  async updateComment(commentId: number, body: string): Promise<Comment> {
    if (this.deny_writes) {
      throw new GitHubPermissionError('read-only token: cannot update comment');
    }
    for (const row of this.comments) {
      if (row.id === commentId) {
        row.body = body;
        return row;
      }
    }
    throw new Error(`no comment with id ${commentId}`);
  }
}

/**
 * Outcome of an {@link upsertStickyComment} call.
 *
 * `action` is `"created"` | `"updated"` | `"degraded"`. `comment_id` is the
 * affected comment id (`null` when degraded). `notice` carries the degradation
 * message and is set **only** when `action === "degraded"`.
 */
export interface UpsertResult {
  action: string;
  comment_id: number | null;
  notice: string | null;
}

/** Return the first comment whose body contains `marker`, else `null`. */
export function findSticky(
  comments: Comment[],
  marker: string = STICKY_MARKER,
): Comment | null {
  for (const comment of comments) {
    if ((comment.body ?? '').includes(marker)) {
      return comment;
    }
  }
  return null;
}

/**
 * Post or update the single sticky guardian comment (SC-9).
 *
 * Locates the existing comment by `marker`; updates it in place when present,
 * otherwise creates a new one. Never stacks duplicates. A read-only token (fork
 * PR?) degrades loudly to a `degraded` result rather than crashing (OT-4).
 */
export async function upsertStickyComment(
  client: GitHubClient,
  body: string,
  marker: string = STICKY_MARKER,
): Promise<UpsertResult> {
  const existing = findSticky(await client.listComments(), marker);
  try {
    if (existing !== null) {
      const updated = await client.updateComment(existing.id, body);
      return { action: 'updated', comment_id: updated.id, notice: null };
    }
    const created = await client.createComment(body);
    return { action: 'created', comment_id: created.id, notice: null };
  } catch (err) {
    if (err instanceof GitHubPermissionError) {
      // OT-4 / SC-1+D6: a read-only token (fork PR?) must degrade loudly, not
      // crash the job. The caller emits `notice` as a `::warning::` annotation.
      return {
        action: 'degraded',
        comment_id: null,
        notice:
          'guardian: read-only token (fork PR?) — findings not posted as ' +
          'a comment',
      };
    }
    throw err;
  }
}

/** Return a GitHub Actions `::warning::` annotation line for `notice`. */
export function degradationAnnotation(notice: string): string {
  return `::warning::${notice}`;
}

/**
 * Thin real {@link GitHubClient} over the GitHub REST API (`fetch`).
 *
 * Python's private `_RestGitHubClient`, exported here (public, like
 * {@link RestBranchProtectionClient}). Network lives ONLY here; **no unit test
 * exercises this class**. A 403 (fork read-only token) surfaces as
 * {@link GitHubPermissionError} so the caller degrades loudly rather than
 * crashing.
 *
 * Comments live on the *issues* endpoint (a PR is an issue):
 * `https://api.github.com/repos/{repo}/issues/{pr}/comments`.
 */
export class RestGitHubClient implements GitHubClient {
  private static readonly API = 'https://api.github.com';

  constructor(
    private readonly repo: string,
    private readonly prNumber: number,
    private readonly token: string,
  ) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'canary-pr-guardian',
    };
  }

  private async request(
    method: string,
    url: string,
    payload?: unknown,
  ): Promise<unknown> {
    const init: RequestInit = { method, headers: this.headers() };
    if (payload !== undefined) {
      init.body = JSON.stringify(payload);
    }
    const resp = await fetch(url, init);
    if (!resp.ok) {
      // As in the oracle, ONLY 403 maps to a permission error; any other
      // non-2xx propagates (the analog of urllib's HTTPError re-raise).
      if (resp.status === 403) {
        throw new GitHubPermissionError(
          `GitHub API 403 (read-only token / fork PR?): ${url}`,
        );
      }
      throw new Error(`GitHub API ${resp.status}: ${url}`);
    }
    return resp.json();
  }

  async listComments(): Promise<Comment[]> {
    const url = `${RestGitHubClient.API}/repos/${this.repo}/issues/${this.prNumber}/comments`;
    const result = await this.request('GET', url);
    return Array.isArray(result) ? (result as Comment[]) : [];
  }

  async createComment(body: string): Promise<Comment> {
    const url = `${RestGitHubClient.API}/repos/${this.repo}/issues/${this.prNumber}/comments`;
    const result = await this.request('POST', url, { body });
    return isRecord(result) ? (result as unknown as Comment) : ({} as Comment);
  }

  async updateComment(commentId: number, body: string): Promise<Comment> {
    const url = `${RestGitHubClient.API}/repos/${this.repo}/issues/comments/${commentId}`;
    const result = await this.request('PATCH', url, { body });
    return isRecord(result) ? (result as unknown as Comment) : ({} as Comment);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
