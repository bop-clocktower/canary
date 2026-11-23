/**
 * Which PR comment is guardian's own sticky (#931), split out of
 * `pr-comment.ts` to keep that module under its file-length budget. Pure: no
 * network, no client -- callers hand in the comment rows.
 */

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

export const DEFAULT_IDENTITY: GuardianIdentity = {
  login: 'github-actions[bot]',
};

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
