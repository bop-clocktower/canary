/**
 * A 403 on the sticky LOOKUP must degrade exactly like a 403 on the write
 * (OT-4). `upsertStickyComment` promises "a 403 degrades to a `degraded`
 * result instead of crashing the job", and #528 made the paged read map 403 to
 * {@link GitHubPermissionError} precisely so a fork PR "degrades identically on
 * a paged read and an unpaged write". The read, however, ran outside the
 * degrade guard, so a read-side 403 (a token without comment read access, or a
 * 403 rate limit) escaped as an exception and crashed `pr-check`.
 *
 * Found by bug-fleet (area A2, base b0e258bd).
 */

import { describe, expect, it } from 'vitest';

import {
  type Comment,
  type GitHubClient,
  GitHubPermissionError,
  upsertStickyComment,
} from '../src/guardian/pr-comment.js';

/** A client whose comment LIST is forbidden; writes are never reached. */
class ReadForbiddenClient implements GitHubClient {
  async listComments(): Promise<Comment[]> {
    throw new GitHubPermissionError('GitHub API 403: list comments');
  }
  async createComment(): Promise<Comment> {
    throw new Error('unreachable: create after a failed list');
  }
  async updateComment(): Promise<Comment> {
    throw new Error('unreachable: update after a failed list');
  }
}

describe('upsertStickyComment: 403 on the read path (OT-4)', () => {
  it('degrades instead of throwing when listing comments is forbidden', async () => {
    await expect(
      upsertStickyComment(new ReadForbiddenClient(), 'body'),
    ).resolves.toMatchObject({ action: 'degraded', comment_id: null });
  });
});
