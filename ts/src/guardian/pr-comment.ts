/**
 * Deterministic poster of the single sticky guardian PR comment (Tier 0; no
 * agent/LLM import, SC-11). {@link GitHubClient} is the seam;
 * {@link FakeGitHubClient} is the in-memory test double (`deny_writes` models a
 * 403); {@link RestGitHubClient} is the only code that touches the network.
 */

import { PageReader, readAllPages, restPageReader } from './github-paging.js';

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

/** Map a non-2xx status to an error; ONLY 403 is a permission error. */
function toGitHubError(status: number, url: string): Error {
  return status === 403
    ? new GitHubPermissionError(
        `GitHub API 403 (read-only token / fork PR?): ${url}`,
      )
    : new Error(`GitHub API ${status}: ${url}`);
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
 * A 403 degrades to a `degraded` result instead of crashing the job (OT-4).
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
      return {
        action: 'degraded',
        comment_id: null,
        notice: `guardian: token lacks write permission on PR comments (HTTP 403) — findings not posted as a comment`,
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
 * {@link RestBranchProtectionClient}). Network lives ONLY in `request` and in
 * the default {@link restPageReader}; the write paths have no unit test by
 * design, while the paged read path is covered through the injected `read`
 * seam (#528). A 403 (fork read-only token) surfaces as
 * {@link GitHubPermissionError} so the caller degrades loudly rather than
 * crashing.
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
  ) {
    // The `read` seam exists so #528's paging is testable without a socket;
    // production callers pass three arguments and get the real reader. It
    // shares `request`'s 403 mapping so a fork PR degrades identically on a
    // paged read and an unpaged write.
    this.read = read ?? restPageReader(this.headers(), toGitHubError);
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
    const resp = await fetch(url, init);
    if (!resp.ok) throw toGitHubError(resp.status, url);
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
