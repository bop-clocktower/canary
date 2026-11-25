/**
 * Who wrote a guardian sticky comment (#931, #1352, #1685). Split out of
 * pr-comment.ts so the identity rules live in one small, pure module.
 */

/** The author of a comment, as the REST API reports it. */
export interface CommentAuthor {
  user?: { login: string; type?: string } | null;
  performed_via_github_app?: { slug: string } | null;
}

/**
 * Who guardian posts as (configured: the Actions token can't `GET /user`).
 * `login` unset = `github-actions[bot]`; `appSlug` admits that App's `Bot`.
 */
export interface GuardianIdentity {
  login?: string;
  appSlug?: string;
}

export const DEFAULT_LOGIN = 'github-actions[bot]';

/**
 * Canonical form of a GitHub login: lower-case (logins are case-insensitive)
 * with one leading `@` dropped. `||`, not `??`: an empty login means "unset"
 * and falls back to the default, so it can never match an empty author.
 */
export function normalizeLogin(login: string | undefined): string {
  return (login || DEFAULT_LOGIN).replace(/^@/, '').toLowerCase();
}

/** True when `identity` wrote `c`: its login, or a `Bot` acting as its App. */
export function isAuthoredBy(
  c: CommentAuthor,
  identity: GuardianIdentity,
): boolean {
  const author = c.user?.login;
  if (author && normalizeLogin(author) === normalizeLogin(identity.login)) {
    return true;
  }
  const slug = c.performed_via_github_app?.slug;
  return c.user?.type === 'Bot' && !!slug && slug === identity.appSlug;
}

/**
 * The notice for a comment just posted under an author `identity` would never
 * adopt (next run would stack a copy), else `null`. No author, no verdict.
 */
export function misidentifiedNotice(
  posted: CommentAuthor,
  identity: GuardianIdentity,
): string | null {
  const author = posted.user?.login;
  if (!author || isAuthoredBy(posted, identity)) return null;
  return `guardian: sticky comment posted as ${author}; set CANARY_GUARDIAN_LOGIN=${author} or the next run stacks a new comment`;
}
