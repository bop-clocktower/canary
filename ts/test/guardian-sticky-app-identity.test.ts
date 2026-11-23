/**
 * #1352: guardian's sticky must be updated in place, never stacked (SC-9),
 * whoever the token posts as. `findSticky` (#931) recognised only the default
 * `github-actions[bot]` login or a configured app slug, and nothing on the
 * production path configures one, so an App installation token or a PAT
 * stacked a new comment on every run.
 *
 * The fix learns the identity from guardian's own write: GitHub stamps the
 * created comment with its author, and guardian records that login in a hidden
 * stamp after the marker. A later run accepts a marker-led comment whose stamp
 * names the comment's REAL author -- so a human who pastes guardian's output
 * (stamp included) is still never overwritten (#931).
 */

import { describe, expect, it } from 'vitest';

import {
  Comment,
  GitHubClient,
  STICKY_MARKER,
  findSticky,
  upsertStickyComment,
} from '../src/guardian/pr-comment.js';

/** An in-memory client whose token posts as `user`. */
class TokenClient implements GitHubClient {
  readonly comments: Comment[] = [];
  updates = 0;
  private nextId = 1;

  constructor(
    private readonly user: { login: string; type: string },
    private readonly app: { slug: string } | null = null,
  ) {}

  async listComments(): Promise<Comment[]> {
    return this.comments;
  }

  async createComment(body: string): Promise<Comment> {
    const row: Comment = {
      id: this.nextId++,
      body,
      user: { ...this.user },
      performed_via_github_app: this.app,
      created_at: `2026-01-0${this.nextId}T00:00:00Z`,
    };
    this.comments.push(row);
    return { ...row };
  }

  async updateComment(commentId: number, body: string): Promise<Comment> {
    this.updates += 1;
    const row = this.comments.find((c) => c.id === commentId)!;
    row.body = body;
    return { ...row };
  }
}

const APP = { login: 'example-app[bot]', type: 'Bot' };
const PAT = { login: 'release-robot', type: 'User' };

describe('sticky upsert under a non-default token identity (#1352)', () => {
  it('a second run updates the sticky the first run created (no stacking)', async () => {
    const client = new TokenClient(APP, { slug: 'example-app' });
    await upsertStickyComment(client, `${STICKY_MARKER}\nrun one`);
    await upsertStickyComment(client, `${STICKY_MARKER}\nrun two`);
    expect(client.comments).toHaveLength(1);
    expect(client.comments[0]!.body).toContain('run two');
  });

  it('a PAT posting as a user account does not stack either', async () => {
    const client = new TokenClient(PAT);
    for (const run of ['one', 'two', 'three']) {
      await upsertStickyComment(client, `${STICKY_MARKER}\nrun ${run}`);
    }
    expect(client.comments).toHaveLength(1);
    expect(client.comments[0]!.body).toContain('run three');
  });

  it('keeps the marker as the first thing in the body', async () => {
    const client = new TokenClient(PAT);
    await upsertStickyComment(client, `${STICKY_MARKER}\nrun one`);
    expect(client.comments[0]!.body.startsWith(STICKY_MARKER)).toBe(true);
  });

  it('never adopts a human comment that pasted a stamped sticky (#931)', async () => {
    const client = new TokenClient(PAT);
    await upsertStickyComment(client, `${STICKY_MARKER}\nrun one`);
    const pasted: Comment = {
      id: 99,
      body: client.comments[0]!.body,
      user: { login: 'alice', type: 'User' },
      created_at: '2026-02-01T00:00:00Z',
    };
    expect(findSticky([pasted])).toBeNull();
  });

  it('the default Actions identity is unchanged: one write, no stamp', async () => {
    const client = new TokenClient({
      login: 'github-actions[bot]',
      type: 'Bot',
    });
    const body = `${STICKY_MARKER}\nrun one`;
    await upsertStickyComment(client, body);
    expect(client.updates).toBe(0);
    expect(client.comments[0]!.body).toBe(body);
  });
});
