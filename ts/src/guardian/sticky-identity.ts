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
  const body = (c.body ?? '').trimStart();
  if (!body.startsWith(marker)) return false;
  return isAuthoredBy(c, id) || isSelfStamped(c, body.slice(marker.length));
}

/**
 * The hidden author stamp (#1352). Nothing on the production path can tell
 * guardian who its token posts as -- an App installation token or a PAT is
 * not `github-actions[bot]`, and neither can call an API that says so -- so
 * guardian learns it from its own write: GitHub stamps a created comment with
 * its author, and guardian records that login right after the marker. Only
 * the stamp's NAMED author qualifies, so a human who pastes a stamped sticky
 * is still never overwritten (#931): the paste is authored by them, not by
 * the login the stamp names.
 */
const AUTHOR_STAMP = /^<!-- sticky-author: (\S+) -->/;

function isSelfStamped(c: Comment, afterMarker: string): boolean {
  const login = AUTHOR_STAMP.exec(afterMarker)?.[1];
  return login !== undefined && login === c.user?.login;
}

/**
 * `body` as guardian should write it over `comment` (one it created or found):
 * stamped with the comment's real author when that author is not `identity`,
 * unchanged otherwise -- so the default Actions token writes exactly as before.
 */
export function stampedFor(
  body: string,
  marker: string,
  comment: Comment,
  identity: GuardianIdentity = DEFAULT_IDENTITY,
): string {
  const login = comment.user?.login;
  if (!login || isAuthoredBy(comment, identity) || !body.startsWith(marker))
    return body;
  return `${marker}<!-- sticky-author: ${login} -->${body.slice(marker.length)}`;
}

function isAuthoredBy(c: Comment, identity: GuardianIdentity): boolean {
  if (c.user?.login === identity.login) return true;
  const slug = c.performed_via_github_app?.slug;
  return c.user?.type === 'Bot' && !!slug && slug === identity.appSlug;
}
