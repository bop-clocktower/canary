/**
 * #1678: `canary briefing --comment` stacked a new charter comment on every
 * run when its token posted as anyone but `github-actions[bot]` (a GitHub App
 * installation token, or a PAT) — the same class of bug as guardian's #1352.
 * The briefing path now honors guardian's `CANARY_GUARDIAN_LOGIN` /
 * `CANARY_GUARDIAN_APP_SLUG`, read at the briefing CLI edge and passed to
 * `postCharter`. These tests drive the production path: the CLI.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { postCharter } from '../src/briefing/comment.js';
import { type Comment, FakeGitHubClient } from '../src/guardian/pr-comment.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

/** The spec's literal marker, not an import of the constant. */
const BRIEFING_MARKER = '<!-- canary-mission-briefing -->';

const DIFF = [
  'diff --git a/src/discount.ts b/src/discount.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/discount.ts',
  '@@ -0,0 +1,3 @@',
  '+export function discount(n: number): number {',
  '+  return n * 0.9;',
  '+}',
  '',
].join('\n');

type Author = Pick<Comment, 'user' | 'performed_via_github_app'>;

const APP_AUTHOR: Author = {
  user: { login: 'example-app[bot]', type: 'Bot' },
  performed_via_github_app: { slug: 'example-app' },
};
const PAT_AUTHOR: Author = { user: { login: 'ci-service-user', type: 'User' } };

/** A fake whose token posts as a fixed, non-default author. */
class IdentityClient extends FakeGitHubClient {
  constructor(private readonly author: Author) {
    super();
  }

  override async createComment(body: string): Promise<Comment> {
    const row = await super.createComment(body);
    Object.assign(row, this.author);
    return row;
  }
}

const PR_ENV = { GITHUB_REPOSITORY: 'o/r', GITHUB_REF: 'refs/pull/7/merge' };
const mine = (c: Comment): boolean => c.body.startsWith(BRIEFING_MARKER);

let root: string;
let diffPath: string;
beforeEach(() => {
  root = mkTmp();
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'discount.ts'),
    'export function discount(n: number): number {\n  return n * 0.9;\n}\n',
    'utf-8',
  );
  diffPath = join(root, 'change.diff');
  writeFileSync(diffPath, DIFF, 'utf-8');
});
afterEach(() => {
  rmTmp(root);
});

/** Run `briefing --comment` twice against `client` with `env` layered on PR. */
async function twoRuns(
  client: FakeGitHubClient,
  env: Record<string, string>,
): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    const res = await invokeCanary(
      ['briefing', '--diff', diffPath, '--comment'],
      {
        cwd: root,
        env: { ...PR_ENV, ...env },
        deps: { buildCommentClient: () => client },
      },
    );
    expect(res.code).toBe(0);
    out.push(res.stdout);
  }
  return out;
}

describe('briefing sticky under a non-default token identity (#1678)', () => {
  it('CANARY_GUARDIAN_APP_SLUG: a second run updates the App-authored charter', async () => {
    const client = new IdentityClient(APP_AUTHOR);
    const [, second] = await twoRuns(client, {
      CANARY_GUARDIAN_APP_SLUG: 'example-app',
    });
    expect(client.comments.filter(mine)).toHaveLength(1);
    expect(second).toMatch(/\(updated, id \d+\)/);
  });

  it('CANARY_GUARDIAN_LOGIN: a second run updates the PAT-authored charter', async () => {
    const client = new IdentityClient(PAT_AUTHOR);
    await twoRuns(client, { CANARY_GUARDIAN_LOGIN: 'ci-service-user' });
    expect(client.comments.filter(mine)).toHaveLength(1);
  });

  it('unset (and blank) keeps the github-actions[bot] default', async () => {
    for (const env of [{}, { CANARY_GUARDIAN_LOGIN: ' ' }]) {
      const client = new FakeGitHubClient();
      await twoRuns(client, env);
      expect(client.comments.filter(mine)).toHaveLength(1);
    }
  });

  it('a configured login no longer adopts a github-actions[bot] charter', async () => {
    // The login REPLACES the default, as it does for guardian: a charter some
    // other identity wrote is never overwritten.
    const client = new IdentityClient(PAT_AUTHOR);
    client.comments.push({
      id: 1,
      body: `${BRIEFING_MARKER}\nold`,
      user: { login: 'github-actions[bot]', type: 'Bot' },
    });
    await twoRuns(client, { CANARY_GUARDIAN_LOGIN: 'ci-service-user' });
    expect(client.comments[0]!.body).toBe(`${BRIEFING_MARKER}\nold`);
    expect(client.comments.filter(mine)).toHaveLength(2);
  });
});

describe('briefing --comment surfaces an unadoptable post on stderr (#1685)', () => {
  it('posts the charter, says so on stdout, and warns on stderr', async () => {
    // A PAT posts as ci-service-user while the sticky identity is the default,
    // so the next run would not adopt this comment. Assert what the user SEES
    // (the stderr warning), not just that postCharter returned a notice.
    const client = new IdentityClient(PAT_AUTHOR);
    const res = await invokeCanary(
      ['briefing', '--diff', diffPath, '--comment'],
      {
        cwd: root,
        env: PR_ENV,
        deps: { buildCommentClient: () => client },
      },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Charter posted as a PR comment');
    expect(res.stderr).toContain(
      '::warning::canary briefing: sticky comment posted as ci-service-user',
    );
  });
});

describe('postCharter identity parameter (#1678)', () => {
  it('matches the sticky by the identity it is given', async () => {
    const client = new IdentityClient(APP_AUTHOR);
    const id = { appSlug: 'example-app' };
    await postCharter(client, 'one', id);
    const r = await postCharter(client, 'two', id);
    expect(r).toMatchObject({ kind: 'posted', action: 'updated' });
    expect(client.comments).toHaveLength(1);
  });
});
