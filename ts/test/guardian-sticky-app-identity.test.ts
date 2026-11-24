/**
 * #1352: guardian's sticky PR comment stacked a new copy on every run when its
 * token posted as anyone but `github-actions[bot]` (a GitHub App installation
 * token, or a PAT). `findSticky` (#931) could match an App identity, but nothing
 * on the production path could configure one. The identity now comes from
 * `CANARY_GUARDIAN_LOGIN` / `CANARY_GUARDIAN_APP_SLUG`, read at the CLI edge and
 * passed down to `upsertStickyComment` and `GitHubAdjudicationSource`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AdjudicationSource,
  GitHubAdjudicationSource,
} from '../src/guardian/adjudication-github.js';
import {
  Comment,
  GitHubClient,
  STICKY_MARKER,
  upsertStickyComment,
} from '../src/guardian/pr-comment.js';
import { invokeGuardian, mkTmp, rmTmp } from './guardian-cli-testkit.js';

/** An in-memory client whose token posts as a fixed (non-default) author. */
class IdentityClient implements GitHubClient {
  readonly comments: Comment[];
  private nextId = 100;

  constructor(
    private readonly author: Pick<Comment, 'user' | 'performed_via_github_app'>,
    seed: Comment[] = [],
  ) {
    this.comments = seed;
  }

  async listComments(): Promise<Comment[]> {
    return this.comments;
  }

  async createComment(body: string): Promise<Comment> {
    this.nextId += 1;
    const row: Comment = {
      id: this.nextId,
      body,
      ...this.author,
      created_at: `2026-01-01T00:00:${this.nextId}Z`,
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

const APP_AUTHOR = {
  user: { login: 'example-app[bot]', type: 'Bot' },
  performed_via_github_app: { slug: 'example-app' },
};
const PAT_AUTHOR = { user: { login: 'ci-service-user', type: 'User' } };
const ACTIONS_AUTHOR = { user: { login: 'github-actions[bot]', type: 'Bot' } };

const CI_ENV = { GITHUB_REPOSITORY: 'o/r', GITHUB_REF: 'refs/pull/7/merge' };

const DIFF = `diff --git a/pkg/widget.py b/pkg/widget.py
index 1111111..2222222 100644
--- a/pkg/widget.py
+++ b/pkg/widget.py
@@ -0,0 +1,3 @@
+def widget():
+    return 42
+
`;

let tmp: string;
beforeEach(() => {
  tmp = mkTmp();
});
afterEach(() => {
  rmTmp(tmp);
});

/** Run `pr-check --post-comment` against `client` with `env` layered on CI. */
async function postRun(
  client: GitHubClient,
  env: Record<string, string>,
): Promise<void> {
  await invokeGuardian(['pr-check', '--diff', '-', '--post-comment'], {
    input: DIFF,
    env: { ...CI_ENV, ...env },
    cwd: tmp,
    deps: { buildCommentClient: () => client },
  });
}

const marked = (c: Comment): boolean => c.body.startsWith(STICKY_MARKER);

describe('sticky upsert under a non-default token identity (#1352)', () => {
  it('a second run updates the sticky the first run created (no stacking)', async () => {
    // The issue's repro, driven through the production path: the CLI.
    const client = new IdentityClient(APP_AUTHOR);
    const env = { CANARY_GUARDIAN_APP_SLUG: 'example-app' };
    await postRun(client, env);
    await postRun(client, env);
    expect(client.comments.filter(marked)).toHaveLength(1);
  });

  it('CANARY_GUARDIAN_LOGIN names a PAT author, so its sticky is reused', async () => {
    const client = new IdentityClient(PAT_AUTHOR);
    const env = { CANARY_GUARDIAN_LOGIN: 'ci-service-user' };
    await postRun(client, env);
    await postRun(client, env);
    expect(client.comments.filter(marked)).toHaveLength(1);
  });

  it('CANARY_GUARDIAN_LOGIN replaces the github-actions[bot] default', async () => {
    const stale = {
      id: 1,
      body: `${STICKY_MARKER}\nold`,
      ...ACTIONS_AUTHOR,
    };
    const client = new IdentityClient(PAT_AUTHOR, [stale]);
    await postRun(client, { CANARY_GUARDIAN_LOGIN: 'ci-service-user' });
    expect(stale.body).toBe(`${STICKY_MARKER}\nold`);
    expect(client.comments.filter(marked)).toHaveLength(2);
  });

  it.each(['', '   '])(
    'a blank identity value (%j) counts as unset: the default still matches',
    async (blank) => {
      const client = new IdentityClient(ACTIONS_AUTHOR);
      const env = {
        CANARY_GUARDIAN_LOGIN: blank,
        CANARY_GUARDIAN_APP_SLUG: blank,
      };
      await postRun(client, env);
      await postRun(client, env);
      expect(client.comments.filter(marked)).toHaveLength(1);
    },
  );

  it('a blank login never adopts a comment whose author login is empty', async () => {
    const ghost = { id: 1, body: `${STICKY_MARKER}\nx`, user: { login: '' } };
    const client = new IdentityClient(ACTIONS_AUTHOR, [ghost]);
    await postRun(client, { CANARY_GUARDIAN_LOGIN: '' });
    expect(ghost.body).toBe(`${STICKY_MARKER}\nx`);
  });

  it('a human comment carrying the marker is never adopted, identity or not', async () => {
    const pasted = `${STICKY_MARKER}\npasted by a human`;
    const human = {
      id: 1,
      body: pasted,
      user: { login: 'someone', type: 'User' },
    };
    // A human acting through the same App is still a User, not the Bot.
    const viaApp = {
      id: 2,
      body: pasted,
      user: { login: 'someone-else', type: 'User' },
      performed_via_github_app: { slug: 'example-app' },
    };
    const client = new IdentityClient(APP_AUTHOR, [human, viaApp]);
    await postRun(client, {
      CANARY_GUARDIAN_LOGIN: 'example-app[bot]',
      CANARY_GUARDIAN_APP_SLUG: 'example-app',
    });
    expect(human.body).toBe(pasted);
    expect(viaApp.body).toBe(pasted);
    expect(client.comments.filter(marked)).toHaveLength(3);
  });

  it('upsertStickyComment takes the identity as a parameter', async () => {
    const client = new IdentityClient(APP_AUTHOR);
    const identity = { login: 'github-actions[bot]', appSlug: 'example-app' };
    await upsertStickyComment(
      client,
      `${STICKY_MARKER}\none`,
      STICKY_MARKER,
      identity,
    );
    await upsertStickyComment(
      client,
      `${STICKY_MARKER}\ntwo`,
      STICKY_MARKER,
      identity,
    );
    expect(client.comments).toHaveLength(1);
    expect(client.comments[0]!.body).toContain('two');
  });
});

describe('precision reads the sticky under the configured identity (#1352)', () => {
  it('the CLI passes the env identity to the adjudication source', async () => {
    const seen: unknown[] = [];
    const empty: AdjudicationSource = {
      mergedPrs: async () => [],
      stickyHistory: async () => null,
      prFiles: async () => [],
    };
    await invokeGuardian(['precision', '--repo', 'o/r'], {
      env: {
        GITHUB_TOKEN: 'tok',
        CANARY_GUARDIAN_LOGIN: 'example-app[bot]',
        CANARY_GUARDIAN_APP_SLUG: 'example-app',
      },
      deps: {
        buildAdjudicationSource: (_repo, _token, identity) => {
          seen.push(identity);
          return empty;
        },
      },
    });
    expect(seen).toEqual([
      { login: 'example-app[bot]', appSlug: 'example-app' },
    ]);
  });

  it('GitHubAdjudicationSource finds an App-authored sticky', async () => {
    const sticky = {
      id: 9,
      node_id: 'IC_9',
      body: `${STICKY_MARKER}\nlast`,
      ...APP_AUTHOR,
    };
    const source = new GitHubAdjudicationSource(
      'o/r',
      'tok',
      {
        read: async () => ({ body: [sticky], linkHeader: null }),
        graphql: async () => ({
          node: { userContentEdits: { totalCount: 0, nodes: [] } },
        }),
      },
      { login: 'github-actions[bot]', appSlug: 'example-app' },
    );
    const history = await source.stickyHistory(7);
    expect(history?.revisions).toEqual([`${STICKY_MARKER}\nlast`]);
  });
});
