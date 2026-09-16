/**
 * `postCharter` (#593 D3, criteria 6 and 10): the charter is its own sticky
 * comment. The guardian fixture is authored by `github-actions[bot]` — the
 * guardian's default identity — so if the two markers ever collided the
 * guardian comment WOULD be overwritten, which keeps "untouched" non-vacuous.
 */
import { describe, expect, it } from 'vitest';
import {
  BRIEFING_MARKER,
  commentClientFor,
  postCharter,
} from '../src/briefing/comment.js';
import {
  FakeGitHubClient,
  RestGitHubClient,
  STICKY_MARKER,
} from '../src/guardian/pr-comment.js';
import { defaultMainDeps } from '../src/main-deps.js';

const bot = { login: 'github-actions[bot]', type: 'Bot' };
const guardianBody = `${STICKY_MARKER}\n## Guardian verdict`;

describe('postCharter (criteria 6, 10)', () => {
  it.each([
    ['with a guardian sticky', true],
    ['without one', false],
  ])(
    'posts under its own marker %s and never edits the guardian comment',
    async (_l, withGuardian) => {
      const fake = new FakeGitHubClient({
        comments: withGuardian
          ? [{ id: 1, body: guardianBody, user: bot }]
          : [],
      });
      const r = await postCharter(
        fake,
        '## Test charter (advisory, not a gate)',
      );
      expect(r).toMatchObject({ kind: 'posted', action: 'created' });
      const mine = fake.comments.filter((c) =>
        c.body?.startsWith(BRIEFING_MARKER),
      );
      expect(mine).toHaveLength(1);
      expect(fake.comments).toHaveLength(withGuardian ? 2 : 1);
      if (withGuardian) expect(fake.comments[0]!.body).toBe(guardianBody);
    },
  );

  it('updates its own comment on a second run instead of stacking', async () => {
    const fake = new FakeGitHubClient({
      comments: [{ id: 1, body: guardianBody, user: bot }],
    });
    await postCharter(fake, 'one');
    const r = await postCharter(fake, 'two');
    expect(r).toMatchObject({ kind: 'posted', action: 'updated' });
    expect(fake.comments).toHaveLength(2);
    expect(fake.comments[0]!.body).toBe(guardianBody);
    expect(fake.comments[1]!.body).toBe(`${BRIEFING_MARKER}\ntwo`);
  });

  it('degrades on 403 with a briefing-specific notice', async () => {
    const r = await postCharter(
      new FakeGitHubClient({ deny_writes: true }),
      'c',
    );
    expect(r.kind).toBe('degraded');
    if (r.kind === 'degraded')
      expect(r.notice).toMatch(/^canary briefing: .*HTTP 403/);
  });

  it('degrades on any other client error rather than throwing', async () => {
    const broken = new FakeGitHubClient();
    broken.listComments = async () => {
      throw new Error('boom');
    };
    const r = await postCharter(broken, 'c');
    expect(r).toMatchObject({ kind: 'degraded' });
    if (r.kind === 'degraded') expect(r.notice).toContain('boom');
  });
});

describe('commentClientFor', () => {
  const PR_ENV = { GITHUB_REPOSITORY: 'o/r', GITHUB_REF: 'refs/pull/7/merge' };
  it('defaults the comment client to the REST client in a PR context', () => {
    expect(commentClientFor(PR_ENV)).toBeInstanceOf(RestGitHubClient);
  });
  it('uses an injected builder with the PR repo and number', () => {
    const fake = new FakeGitHubClient();
    const seen: unknown[] = [];
    const client = commentClientFor(PR_ENV, (repo, pr) => {
      seen.push(repo, pr);
      return fake;
    });
    expect(client).toBe(fake);
    expect(seen).toEqual(['o/r', 7]);
  });
  it('returns null without a PR context', () => {
    expect(commentClientFor({})).toBeNull();
  });
  it('leaves the MainDeps seam unset so production takes the default', () => {
    expect(defaultMainDeps().buildCommentClient).toBeUndefined();
  });
});
