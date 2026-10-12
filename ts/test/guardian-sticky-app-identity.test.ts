/**
 * SC-9: the sticky comment is updated in place, never stacked.
 *
 * `findSticky` (#931) recognises guardian's own comment by author: the default
 * `github-actions[bot]` login, or an `appSlug` identity. Nothing on the
 * production path (`upsertStickyComment`, `postStickyComment`, the CLI) can
 * supply that identity, so a run whose token posts as anything else -- a GitHub
 * App installation token (`<slug>[bot]`) or a PAT -- never finds the sticky it
 * wrote itself and creates a new one on every run.
 */

import { describe, expect, it } from 'vitest';

import {
  Comment,
  GitHubClient,
  upsertStickyComment,
} from '../src/guardian/pr-comment.js';

/** An in-memory client whose token posts as a GitHub App bot. */
class AppTokenClient implements GitHubClient {
  readonly comments: Comment[] = [];
  private nextId = 1;

  async listComments(): Promise<Comment[]> {
    return this.comments;
  }

  async createComment(body: string): Promise<Comment> {
    const row: Comment = {
      id: this.nextId++,
      body,
      user: { login: 'example-app[bot]', type: 'Bot' },
      performed_via_github_app: { slug: 'example-app' },
      created_at: `2026-01-0${this.nextId}T00:00:00Z`,
    };
    this.comments.push(row);
    return row;
  }

  async updateComment(commentId: number, body: string): Promise<Comment> {
    const row = this.comments.find((c) => c.id === commentId)!;
    row.body = body;
    return row;
  }
}

describe('sticky upsert under a non-default token identity', () => {
  it('a second run updates the sticky the first run created (no stacking)', async () => {
    const client = new AppTokenClient();
    await upsertStickyComment(client, '<!-- canary-pr-guardian -->\nrun one');
    await upsertStickyComment(client, '<!-- canary-pr-guardian -->\nrun two');
    expect(client.comments).toHaveLength(1);
  });
});
