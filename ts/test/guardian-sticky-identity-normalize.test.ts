/**
 * #1685: a misconfigured sticky identity stacked comments silently. Logins
 * were compared with a strict `===` (GitHub logins are case-insensitive, and a
 * leading `@` is a common way to write one), `?? DEFAULT_LOGIN` let a library
 * caller's `login: ''` adopt an empty-author comment, and a post whose author
 * would never match the configured identity reported nothing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { postCharter } from '../src/briefing/comment.js';
import {
  Comment,
  GitHubClient,
  GuardianIdentity,
  STICKY_MARKER,
  upsertStickyComment,
} from '../src/guardian/pr-comment.js';
import { invokeGuardian, mkTmp, rmTmp } from './guardian-cli-testkit.js';

/** An in-memory client whose token posts as a fixed author. */
class AuthorClient implements GitHubClient {
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
    const row: Comment = { id: this.nextId, body, ...this.author };
    this.comments.push(row);
    return row;
  }

  async updateComment(commentId: number, body: string): Promise<Comment> {
    const row = this.comments.find((c) => c.id === commentId)!;
    row.body = body;
    return row;
  }
}

const PAT_AUTHOR = { user: { login: 'ci-service-user', type: 'User' } };
const ACTIONS_AUTHOR = { user: { login: 'github-actions[bot]', type: 'Bot' } };
const marked = (c: Comment): boolean => c.body.startsWith(STICKY_MARKER);

async function twoRuns(
  client: GitHubClient,
  identity: GuardianIdentity,
): Promise<void> {
  for (const n of ['one', 'two']) {
    await upsertStickyComment(
      client,
      `${STICKY_MARKER}\n${n}`,
      STICKY_MARKER,
      identity,
    );
  }
}

describe('sticky identity is compared after normalising (#1685)', () => {
  it.each(['CI-Service-User', '@ci-service-user', '@CI-SERVICE-USER'])(
    'a configured login %j still finds the sticky its token wrote',
    async (login) => {
      const client = new AuthorClient(PAT_AUTHOR);
      await twoRuns(client, { login });
      expect(client.comments.filter(marked)).toHaveLength(1);
      expect(client.comments[0]!.body).toContain('two');
    },
  );

  it("a library caller's empty login falls back to the default", async () => {
    const ghost = { id: 1, body: `${STICKY_MARKER}\nx`, user: { login: '' } };
    const client = new AuthorClient(ACTIONS_AUTHOR, [ghost]);
    await twoRuns(client, { login: '' });
    expect(ghost.body).toBe(`${STICKY_MARKER}\nx`);
    expect(
      client.comments.filter(
        (c) => marked(c) && c.user?.login === 'github-actions[bot]',
      ),
    ).toHaveLength(1);
  });
});

describe('a post the identity would never adopt is reported (#1685)', () => {
  it('degrades with the login to configure when the author would not match', async () => {
    const client = new AuthorClient(PAT_AUTHOR);
    const res = await upsertStickyComment(
      client,
      `${STICKY_MARKER}\none`,
      STICKY_MARKER,
      {},
    );
    expect(res.action).toBe('degraded');
    expect(res.comment_id).toBe(101);
    expect(res.notice).toContain(
      'posted as ci-service-user; set CANARY_GUARDIAN_LOGIN=ci-service-user',
    );
  });

  it('stays quiet when the created comment is one the identity adopts', async () => {
    const client = new AuthorClient(PAT_AUTHOR);
    const res = await upsertStickyComment(
      client,
      `${STICKY_MARKER}\none`,
      STICKY_MARKER,
      { login: '@CI-Service-User' },
    );
    expect(res).toEqual({ action: 'created', comment_id: 101, notice: null });
  });

  it('stays quiet when the API returned no author to judge', async () => {
    const client = new AuthorClient({});
    const res = await upsertStickyComment(client, `${STICKY_MARKER}\none`);
    expect(res.action).toBe('created');
    expect(res.notice).toBeNull();
  });
});

describe('the CLI surfaces the misidentified post on stderr (#1685)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkTmp();
  });
  afterEach(() => {
    rmTmp(tmp);
  });

  const DIFF = `diff --git a/pkg/widget.py b/pkg/widget.py
index 1111111..2222222 100644
--- a/pkg/widget.py
+++ b/pkg/widget.py
@@ -0,0 +1,3 @@
+def widget():
+    return 42
+
`;

  it('prints the notice on stderr and does not reprint the posted body', async () => {
    const client = new AuthorClient(PAT_AUTHOR);
    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--post-comment'],
      {
        input: DIFF,
        env: { GITHUB_REPOSITORY: 'o/r', GITHUB_REF: 'refs/pull/7/merge' },
        cwd: tmp,
        deps: { buildCommentClient: () => client },
      },
    );
    expect(res.stderr).toContain(
      'posted as ci-service-user; set CANARY_GUARDIAN_LOGIN=ci-service-user',
    );
    expect(res.stdout).not.toContain(STICKY_MARKER);
  });
});

describe('briefing keeps a landed charter as posted (#1685)', () => {
  it('reports the identity notice without claiming the post failed', async () => {
    const client = new AuthorClient(PAT_AUTHOR);
    const res = await postCharter(client, 'charter', {});
    expect(res).toMatchObject({ kind: 'posted', commentId: 101 });
    expect(res.kind === 'posted' && res.notice).toContain(
      'canary briefing: sticky comment posted as ci-service-user',
    );
  });
});
