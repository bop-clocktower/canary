/**
 * Post the charter as its OWN sticky PR comment (#593 D3, criteria 6 and 10).
 *
 * The marker differs from guardian's, and `findSticky` matches on a body that
 * STARTS WITH the marker, so neither comment can overwrite the other. Every
 * write failure degrades: the charter is advisory, so a missing comment
 * must never turn into an exit 1.
 */
import {
  type GitHubClient,
  GitHubPermissionError,
  upsertStickyComment,
} from '../guardian/pr-comment.js';

export const BRIEFING_MARKER = '<!-- canary-mission-briefing -->';

type PostResult =
  | { kind: 'posted'; action: string; commentId: number | null }
  | { kind: 'degraded'; notice: string };

const FORBIDDEN_NOTICE =
  'canary briefing: token lacks write permission on PR comments (HTTP 403) \u{2014} charter printed to stdout instead';

/** Upsert the charter under {@link BRIEFING_MARKER}; never throws. */
export async function postCharter(
  client: GitHubClient,
  charter: string,
): Promise<PostResult> {
  try {
    const r = await upsertStickyComment(
      client,
      `${BRIEFING_MARKER}\n${charter}`,
      BRIEFING_MARKER,
    );
    if (r.action === 'degraded')
      return { kind: 'degraded', notice: FORBIDDEN_NOTICE };
    return { kind: 'posted', action: r.action, commentId: r.comment_id };
  } catch (e) {
    // Non-403 failures (missing token, network) degrade the same way: the
    // charter still reaches stdout, so nothing is lost but the comment.
    const notice =
      e instanceof GitHubPermissionError
        ? FORBIDDEN_NOTICE
        : `canary briefing: could not post the charter comment (${(e as Error).message}) \u{2014} charter printed to stdout instead`;
    return { kind: 'degraded', notice };
  }
}
