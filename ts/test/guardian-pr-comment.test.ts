/**
 * Faithful TypeScript port of `tests/unit/test_guardian_pr_comment.py`.
 *
 * The poster is HTTP behind a {@link GitHubClient} interface seam (SC-11: no
 * agent/LLM import). Every test drives the in-memory {@link FakeGitHubClient};
 * the real {@link RestGitHubClient} (network) is NEVER exercised here.
 */

import { describe, expect, it } from 'vitest';

import {
  type Comment,
  type UpsertResult,
  FakeGitHubClient,
  GitHubPermissionError,
  STICKY_MARKER,
  degradationAnnotation,
  findSticky,
  upsertStickyComment,
} from '../src/guardian/pr-comment.js';

describe('FakeClient — list/create/update, no network', () => {
  it('list returns seeded rows', async () => {
    const seeded: Comment[] = [{ id: 1, body: 'hello' }];
    const client = new FakeGitHubClient({ comments: seeded });
    expect(await client.listComments()).toBe(seeded);
  });

  it('create appends with new id', async () => {
    const client = new FakeGitHubClient();
    const row = await client.createComment('x');
    expect(row.body).toBe('x');
    expect(Number.isInteger(row.id)).toBe(true);
    expect((await client.listComments()).at(-1)).toBe(row);
  });

  it('create ids are unique', async () => {
    const client = new FakeGitHubClient();
    const first = await client.createComment('a');
    const second = await client.createComment('b');
    expect(first.id).not.toBe(second.id);
  });

  it('update mutates matching row', async () => {
    const client = new FakeGitHubClient({
      comments: [{ id: 7, body: 'old' }],
    });
    const updated = await client.updateComment(7, 'new');
    expect(updated.body).toBe('new');
    expect((await client.listComments())[0]!.body).toBe('new');
  });

  it('create denied raises permission error', async () => {
    const client = new FakeGitHubClient({ deny_writes: true });
    await expect(client.createComment('x')).rejects.toBeInstanceOf(
      GitHubPermissionError,
    );
  });

  it('update denied raises permission error', async () => {
    const client = new FakeGitHubClient({
      comments: [{ id: 1, body: 'old' }],
      deny_writes: true,
    });
    await expect(client.updateComment(1, 'new')).rejects.toBeInstanceOf(
      GitHubPermissionError,
    );
  });

  it('sticky marker constant', () => {
    expect(STICKY_MARKER).toBe('<!-- canary-pr-guardian -->');
  });
});

function marked(body: string): string {
  return `${STICKY_MARKER}\n${body}`;
}

describe('Upsert — SC-9: sticky comment upserted by marker, never stacked', () => {
  it('create when absent', async () => {
    const client = new FakeGitHubClient();
    const result = await upsertStickyComment(client, marked('first'));
    expect(result.action).toBe('created');
    const marks = (await client.listComments()).filter((c) =>
      c.body.includes(STICKY_MARKER),
    );
    expect(marks.length).toBe(1);
    expect(result.comment_id).toBe(marks[0]!.id);
  });

  it('second run updates in place', async () => {
    const client = new FakeGitHubClient();
    await upsertStickyComment(client, marked('first'));
    const result = await upsertStickyComment(client, marked('second'));
    expect(result.action).toBe('updated');
    const marks = (await client.listComments()).filter((c) =>
      c.body.includes(STICKY_MARKER),
    );
    expect(marks.length).toBe(1); // SC-9: no stacking
    expect(marks[0]!.body).toBe(marked('second'));
  });

  it('findSticky ignores non-marker comments', () => {
    const comments: Comment[] = [
      { id: 1, body: 'unrelated chatter' },
      { id: 2, body: marked('guardian findings') },
    ];
    const found = findSticky(comments);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(2);
  });

  it('findSticky returns null when absent', () => {
    expect(findSticky([{ id: 1, body: 'nope' }])).toBeNull();
  });

  it('upsert result shape', () => {
    const result: UpsertResult = {
      action: 'created',
      comment_id: 5,
      notice: null,
    };
    expect(result.action).toBe('created');
    expect(result.comment_id).toBe(5);
    expect(result.notice).toBeNull();
  });
});

describe('Degradation — OT-4 / SC-1+D6: read-only token degrades, never crashes', () => {
  it('create path degrades without raising', async () => {
    const client = new FakeGitHubClient({ deny_writes: true });
    const result = await upsertStickyComment(client, marked('body'));
    expect(result.action).toBe('degraded');
    expect(result.comment_id).toBeNull();
    expect(result.notice).toBeTruthy();
  });

  it('update path degrades without raising', async () => {
    // Seed one existing marked comment so the update branch is taken.
    const client = new FakeGitHubClient({
      comments: [{ id: 1, body: marked('old') }],
      deny_writes: true,
    });
    const result = await upsertStickyComment(client, marked('new'));
    expect(result.action).toBe('degraded');
    expect(result.comment_id).toBeNull();
    expect(result.notice).toBeTruthy();
  });

  it('permission error is not propagated', async () => {
    const client = new FakeGitHubClient({ deny_writes: true });
    // Must resolve (swallow GitHubPermissionError), not reject (OT-4).
    await expect(
      upsertStickyComment(client, marked('body')),
    ).resolves.toBeDefined();
  });

  it('degradation annotation format', () => {
    expect(degradationAnnotation('x')).toBe('::warning::x');
  });
});
