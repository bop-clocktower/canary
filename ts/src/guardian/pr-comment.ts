/**
 * Deterministic poster of the single sticky guardian PR comment (Tier 0; no
 * agent/LLM import, SC-11). {@link GitHubClient} is the seam;
 * {@link FakeGitHubClient} is the in-memory test double (`deny_writes` models a
 * 403); {@link RestGitHubClient} is the only code that touches the network.
 */

import { PageReader, readAllPages, restPageReader } from './github-paging.js';
import {
  GitHubPermissionError,
  GitHubRateLimitError,
  GitHubServerError,
  MAX_ATTEMPTS,
  type Sleep,
  fetchWithRetry,
  realSleep,
  toGitHubError,
} from './github-http.js';

// Re-exported: hard-gate, briefing, and the tests catch it from here (#1467
// moved the HTTP error mapping next to the retry it classifies).
export { GitHubPermissionError };

// `renderFindings` writes this literal on a comment body's first line.
export const STICKY_MARKER = '<!-- canary-pr-guardian -->';

/** A GitHub issue comment row, with the REST author fields #931 needs. */
export interface Comment {
  id: number;
  body: string;
  user?: { login: string; type?: string } | null;
  performed_via_github_app?: { slug: string } | null;
  created_at?: string;
}

/**
 * Who guardian posts as. The Actions token cannot call `GET /user`, so the
 * login is configured (default `github-actions[bot]`); `appSlug` admits a
 * `Bot` author acting through that GitHub App.
 */
export interface GuardianIdentity {
  login: string;
  appSlug?: string;
}

const DEFAULT_IDENTITY: GuardianIdentity = { login: 'github-actions[bot]' };

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
    const row: Comment = {
      id: this.nextId,
      body,
      user: { login: DEFAULT_IDENTITY.login, type: 'Bot' },
    };
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

/**
 * Return guardian's sticky comment, else `null` (#931). A comment qualifies
 * only when its body STARTS WITH `marker` and `identity` wrote it, so a human
 * who pasted guardian's output is never overwritten. Newest qualifier wins.
 */
export function findSticky(
  comments: Comment[],
  marker: string = STICKY_MARKER,
  identity: GuardianIdentity = DEFAULT_IDENTITY,
): Comment | null {
  let best: Comment | null = null;
  for (const c of comments.filter((x) => isSticky(x, marker, identity))) {
    if (!best || (c.created_at ?? '') >= (best.created_at ?? '')) best = c;
  }
  return best;
}

function isSticky(c: Comment, marker: string, id: GuardianIdentity): boolean {
  return isAuthoredBy(c, id) && (c.body ?? '').trimStart().startsWith(marker);
}

function isAuthoredBy(c: Comment, identity: GuardianIdentity): boolean {
  if (c.user?.login === identity.login) return true;
  const slug = c.performed_via_github_app?.slug;
  return c.user?.type === 'Bot' && !!slug && slug === identity.appSlug;
}

/**
 * Update guardian's own sticky in place, else create one (SC-9: never stacks).
 * A 403 degrades to a `degraded` result instead of crashing the job (OT-4) --
 * on the lookup as well as the write, since the paged read maps 403 the same
 * way (#528). So does a 429 or 5xx that outlived the client's retries (#1467):
 * none of them says anything about the diff. Any other 4xx still throws.
 */
export async function upsertStickyComment(
  client: GitHubClient,
  body: string,
  marker: string = STICKY_MARKER,
): Promise<UpsertResult> {
  try {
    const existing = findSticky(await client.listComments(), marker);
    if (existing !== null) {
      const updated = await client.updateComment(existing.id, body);
      return { action: 'updated', comment_id: updated.id, notice: null };
    }
    const created = await client.createComment(body);
    return { action: 'created', comment_id: created.id, notice: null };
  } catch (err) {
    if (err instanceof GitHubPermissionError) {
      return {
        action: 'degraded',
        comment_id: null,
        notice: `guardian: token lacks write permission on PR comments (HTTP 403) — findings not posted as a comment`,
      };
    }
    if (err instanceof GitHubRateLimitError) {
      return {
        action: 'degraded',
        comment_id: null,
        notice: `guardian: GitHub API rate limit hit (HTTP ${err.status}) — findings not posted as a comment; re-run the job once the limit resets`,
      };
    }
    if (err instanceof GitHubServerError) {
      return {
        action: 'degraded',
        comment_id: null,
        notice: `guardian: GitHub API server error (HTTP ${err.status}) after ${MAX_ATTEMPTS} attempts — findings not posted as a comment; the check's result is the computed verdict`,
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
 * Exported (public, like {@link RestBranchProtectionClient}). Network lives
 * ONLY in `request` and in
 * the default {@link restPageReader}. Both go through {@link fetchWithRetry}
 * (#1467), so a 5xx/429/rate-limited 403 is retried on reads and the PATCH,
 * while the comment POST retries only a rate limit (a 5xx may have posted);
 * `sleep` is the seam that keeps those retries out of real time in tests, and
 * the paged read path is also covered through the injected `read` seam (#528).
 * A 403 (fork read-only token) surfaces as {@link GitHubPermissionError} so the
 * caller degrades loudly rather than crashing.
 *
 * Comments live on the *issues* endpoint (a PR is an issue):
 * `https://api.github.com/repos/{repo}/issues/{pr}/comments`.
 */
export class RestGitHubClient implements GitHubClient {
  private static readonly API = 'https://api.github.com';

  private readonly read: PageReader;

  constructor(
    private readonly repo: string,
    private readonly prNumber: number,
    private readonly token: string,
    read?: PageReader,
    private readonly sleep: Sleep = realSleep,
  ) {
    // The `read` seam exists so #528's paging is testable without a socket;
    // production callers pass three arguments and get the real reader. It
    // shares `request`'s 403 mapping AND its retry so a fork PR or a GitHub
    // 5xx behaves identically on a paged read and an unpaged write.
    this.read =
      read ??
      restPageReader(this.headers(), toGitHubError, (url, init) =>
        fetchWithRetry(url, init, this.sleep),
      );
  }

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
    const resp = await fetchWithRetry(url, init, this.sleep);
    if (!resp.ok) throw toGitHubError(resp.status, url, resp.headers);
    return resp.json();
  }

  async listComments(): Promise<Comment[]> {
    const url = `${RestGitHubClient.API}/repos/${this.repo}/issues/${this.prNumber}/comments`;
    return (await readAllPages(url, this.read)) as Comment[];
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
