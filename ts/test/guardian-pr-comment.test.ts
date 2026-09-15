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
  type GuardianIdentity,
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
      { id: 2, body: marked('guardian findings'), user: BOT },
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

// #931: a comment is guardian's sticky only when its body STARTS WITH the
// marker AND it was written by the identity guardian posts as.
const BOT = { login: 'github-actions[bot]', type: 'Bot' };
const HUMAN = { login: 'alice', type: 'User' };

/** A FakeGitHubClient whose updateComment calls are recorded. */
function spyClient(comments: Comment[]): {
  client: FakeGitHubClient;
  updatedIds: number[];
} {
  const client = new FakeGitHubClient({ comments });
  const updatedIds: number[] = [];
  const update = client.updateComment.bind(client);
  client.updateComment = async (id, body) => {
    updatedIds.push(id);
    return update(id, body);
  };
  return { client, updatedIds };
}

describe('Author-aware sticky (#931): never overwrite a human comment', () => {
  it('a human comment with the marker mid-body is left alone; guardian creates its own', async () => {
    const humanBody = `root cause write-up\n${STICKY_MARKER}\nquoted output`;
    const { client, updatedIds } = spyClient([
      { id: 1, body: humanBody, user: HUMAN },
    ]);
    const result = await upsertStickyComment(client, marked('findings'));
    expect(result.action).toBe('created');
    expect(result.comment_id).not.toBe(1);
    expect(updatedIds).not.toContain(1);
    expect(client.comments[0]!.body).toBe(humanBody);
  });

  it('a human comment STARTING with the marker (pasted output) is still not updated', async () => {
    const pasted = marked('pasted guardian output');
    const { client, updatedIds } = spyClient([
      { id: 1, body: pasted, user: HUMAN },
    ]);
    const result = await upsertStickyComment(client, marked('findings'));
    expect(result.action).toBe('created');
    expect(updatedIds).toEqual([]);
    expect(client.comments[0]!.body).toBe(pasted);
  });

  it('a bot comment that merely CONTAINS the marker is not the sticky', () => {
    expect(
      findSticky([{ id: 1, body: `note\n${STICKY_MARKER}`, user: BOT }]),
    ).toBeNull();
  });

  it('an existing bot sticky is updated in place, no duplicate (SC-9)', async () => {
    const { client, updatedIds } = spyClient([
      { id: 1, body: marked('human paste'), user: HUMAN },
      { id: 2, body: marked('old'), user: BOT },
    ]);
    const result = await upsertStickyComment(client, marked('new'));
    expect(result).toEqual({ action: 'updated', comment_id: 2, notice: null });
    expect(updatedIds).toEqual([2]);
    expect(client.comments).toHaveLength(2);
  });
});

describe('Author-aware sticky (#931): which guardian comment qualifies', () => {
  it('with two bot stickies the most recently created one is updated', async () => {
    const { client, updatedIds } = spyClient([
      {
        id: 9,
        body: marked('newer'),
        user: BOT,
        created_at: '2026-09-14T10:00:00Z',
      },
      {
        id: 3,
        body: marked('older'),
        user: BOT,
        created_at: '2026-09-01T10:00:00Z',
      },
    ]);
    const result = await upsertStickyComment(client, marked('latest'));
    expect(result.comment_id).toBe(9);
    expect(updatedIds).toEqual([9]);
  });

  it('a Bot comment is guardian-authored only when its app slug is the configured app', () => {
    const appComment: Comment = {
      id: 4,
      body: marked('x'),
      user: { login: 'canary-guardian[bot]', type: 'Bot' },
      performed_via_github_app: { slug: 'canary-guardian' },
    };
    expect(findSticky([appComment])).toBeNull();
    const identity: GuardianIdentity = {
      login: 'github-actions[bot]',
      appSlug: 'canary-guardian',
    };
    expect(findSticky([appComment], STICKY_MARKER, identity)?.id).toBe(4);
    const human = { ...appComment, user: HUMAN };
    expect(findSticky([human], STICKY_MARKER, identity)).toBeNull();
  });
});

describe('Author-aware sticky (#931): fake author and degraded notice', () => {
  it('comments the fake client creates carry the bot identity', async () => {
    const client = new FakeGitHubClient();
    const row = await client.createComment(marked('x'));
    expect(row.user?.login).toBe('github-actions[bot]');
  });

  it('the degraded notice names the permission failure without assuming a fork', async () => {
    const client = new FakeGitHubClient({ deny_writes: true });
    const result = await upsertStickyComment(client, marked('body'));
    expect(result.notice).toContain('403');
    expect(result.notice).not.toContain('fork PR?');
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
      comments: [{ id: 1, body: marked('old'), user: BOT }],
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
