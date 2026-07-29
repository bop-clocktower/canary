/**
 * The stage-and-block-once loop guard, end to end through the CLI seams (#456).
 *
 * `mark-authored` stamps the sentinel with the HEAD sha it was written at, and
 * `author-plan` honors the loop guard ONLY while HEAD still matches that stamp.
 * Once the human reviews and commits the staged tests, HEAD moves and authoring
 * re-enables itself with no manual step -- restoring the "clears on the next
 * commit" half of the contract that died with `hooks/guardian_precommit.py`.
 *
 * Every unverifiable state (missing, unreadable, headerless, garbage header, or
 * an unresolvable HEAD) FAILS OPEN: authoring is allowed. The bug being fixed
 * here was fail-closed-forever, so a fix that keeps that shape is not a fix.
 *
 * Network-free and repo-free: `git` is faked through the injected
 * {@link GuardianDeps} `runGit` seam, so no `git init` and no committer identity
 * are required.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GitResult } from '../src/guardian/cli.js';
import { invokeGuardian, mkTmp, rmTmp } from './guardian-cli-testkit.js';

const DIFF_NEW_UNIT = `diff --git a/pkg/widget.py b/pkg/widget.py
index 1111111..2222222 100644
--- a/pkg/widget.py
+++ b/pkg/widget.py
@@ -0,0 +1,3 @@
+def widget():
+    return 42
+
`;

const SHA_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const SHA_B = '0fedcba987654321fedcba9876543210fedcba98';

let tmp: string;
beforeEach(() => {
  tmp = mkTmp();
  mkdirSync(join(tmp, '.git'), { recursive: true });
});
afterEach(() => {
  rmTmp(tmp);
});

type RunGit = (args: string[]) => GitResult | null;

/**
 * A `runGit` double: resolves the toplevel/git-dir to `tmp` and answers
 * `rev-parse HEAD` with `headResult` verbatim (`null` models a missing `git`
 * binary). Everything else returns empty success.
 */
function fakeGitRaw(headResult: GitResult | null): RunGit {
  return (args: string[]): GitResult | null => {
    const key = args.join(' ');
    if (key === 'rev-parse --show-toplevel') return { code: 0, stdout: tmp };
    if (key === 'rev-parse --git-dir') {
      return { code: 0, stdout: join(tmp, '.git') };
    }
    if (key === 'rev-parse HEAD') return headResult;
    return { code: 0, stdout: '' };
  };
}

/** `runGit` reporting `head` as HEAD; `null` => the rev-parse exits non-zero. */
function fakeGit(head: string | null): RunGit {
  return fakeGitRaw(
    head === null ? { code: 128, stdout: '' } : { code: 0, stdout: head },
  );
}

function sentinelPath(): string {
  return join(tmp, '.git', 'canary-guardian-authored');
}

function writeSentinel(body: string): void {
  writeFileSync(sentinelPath(), body, 'utf-8');
}

function writeAuthoringConfig(): string {
  const p = join(tmp, 'harness.config.json');
  writeFileSync(
    p,
    JSON.stringify({
      canary: { guardian: { preCommit: { enabled: true, authorTests: true } } },
    }),
    'utf-8',
  );
  return p;
}

interface Intent {
  status: string;
  skip_reason: string | null;
}

interface AuthorPlan {
  intents: Intent[];
  block: { block: boolean };
}

/** Run `author-plan` with authoring fully opted in over `runGit`, and parse it. */
async function authorPlanWith(runGit: RunGit): Promise<AuthorPlan> {
  const cfg = writeAuthoringConfig();
  const res = await invokeGuardian(
    ['author-plan', '--diff', '-', '--config', cfg],
    {
      input: DIFF_NEW_UNIT,
      env: { CANARY_GUARDIAN_AGENT: '2' },
      cwd: tmp,
      deps: { runGit },
    },
  );
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout) as AuthorPlan;
}

/** Run `author-plan` at `head` with authoring fully opted in, and parse it. */
function authorPlanAt(head: string | null): Promise<AuthorPlan> {
  return authorPlanWith(fakeGit(head));
}

/**
 * Assert authoring was ALLOWED: at least one intent, and every intent cleared
 * every guard (`planned`, no skip reason). Asserting on `planned` rather than
 * "not loop-guard" is deliberate -- it proves no earlier guard (opt-in, tier,
 * fork, collision) short-circuited ahead of the loop guard, so the test cannot
 * pass for the wrong reason.
 */
function expectAuthoringAllowed(data: AuthorPlan): void {
  expect(data.intents.length).toBeGreaterThan(0);
  expect(data.intents.map((i) => i.skip_reason)).toEqual(
    data.intents.map(() => null),
  );
  expect(data.intents.every((i) => i.status === 'planned')).toBe(true);
  expect(data.block.block).toBe(true);
}

describe('mark-authored HEAD stamp', () => {
  it('records the HEAD sha header above the authored paths', async () => {
    const res = await invokeGuardian(
      ['mark-authored', '--path', 'a/test_x.py', '--path', 'b/test_y.py'],
      { cwd: tmp, deps: { runGit: fakeGit(SHA_A) } },
    );
    expect(res.code).toBe(0);
    expect(readFileSync(sentinelPath(), 'utf-8')).toBe(
      `HEAD ${SHA_A}\na/test_x.py\nb/test_y.py\n`,
    );
  });

  it('omits the header when HEAD cannot be resolved (fails open later)', async () => {
    const res = await invokeGuardian(
      ['mark-authored', '--path', 'a/test_x.py'],
      { cwd: tmp, deps: { runGit: fakeGit(null) } },
    );
    expect(res.code).toBe(0);
    expect(readFileSync(sentinelPath(), 'utf-8')).toBe('a/test_x.py\n');
    // Unstamped => unverifiable => authoring stays available.
    expectAuthoringAllowed(await authorPlanAt(SHA_A));
  });
});

describe('author-plan loop guard (#456)', () => {
  it('fires while HEAD still matches the stamp', async () => {
    writeSentinel(`HEAD ${SHA_A}\npkg/test_widget.py\n`);
    const data = await authorPlanAt(SHA_A);
    expect(data.intents.length).toBeGreaterThan(0);
    expect(data.intents.every((i) => i.status === 'skipped')).toBe(true);
    expect(data.intents[0]!.skip_reason ?? '').toContain('loop-guard');
    expect(data.block.block).toBe(false);
  });

  it('stops firing once a commit moves HEAD -- no manual step', async () => {
    writeSentinel(`HEAD ${SHA_A}\npkg/test_widget.py\n`);
    expectAuthoringAllowed(await authorPlanAt(SHA_B));
  });

  it('describes its own scope honestly (HEAD-bound, not "this run")', async () => {
    writeSentinel(`HEAD ${SHA_A}\npkg/test_widget.py\n`);
    const data = await authorPlanAt(SHA_A);
    const reason = data.intents[0]!.skip_reason ?? '';
    expect(reason).toContain('HEAD');
    expect(reason).not.toContain('this run');
  });

  it('missing sentinel allows authoring', async () => {
    expectAuthoringAllowed(await authorPlanAt(SHA_A));
  });

  it('headerless (legacy) sentinel is malformed -> allows authoring', async () => {
    writeSentinel('pkg/test_widget.py\nother/test_y.py\n');
    expectAuthoringAllowed(await authorPlanAt(SHA_A));
  });

  it('garbage header is malformed -> allows authoring', async () => {
    writeSentinel('HEAD not-a-sha\npkg/test_widget.py\n');
    expectAuthoringAllowed(await authorPlanAt(SHA_A));
  });

  it('empty sentinel is malformed -> allows authoring', async () => {
    writeSentinel('');
    expectAuthoringAllowed(await authorPlanAt(SHA_A));
  });

  it('unreadable sentinel (a directory) -> allows authoring', async () => {
    mkdirSync(sentinelPath(), { recursive: true });
    expectAuthoringAllowed(await authorPlanAt(SHA_A));
  });

  it('unresolvable HEAD cannot verify the stamp -> allows authoring', async () => {
    writeSentinel(`HEAD ${SHA_A}\npkg/test_widget.py\n`);
    expectAuthoringAllowed(await authorPlanAt(null));
  });

  it('missing git binary cannot verify the stamp -> allows authoring', async () => {
    writeSentinel(`HEAD ${SHA_A}\npkg/test_widget.py\n`);
    // `runGit` returns null on a missing binary (the CLI's fail-safe contract).
    expectAuthoringAllowed(await authorPlanWith(fakeGitRaw(null)));
  });

  it('empty HEAD output cannot verify the stamp -> allows authoring', async () => {
    writeSentinel(`HEAD ${SHA_A}\npkg/test_widget.py\n`);
    expectAuthoringAllowed(
      await authorPlanWith(fakeGitRaw({ code: 0, stdout: '  \n' })),
    );
  });

  it('parses a CRLF-terminated header (guard still fires)', async () => {
    writeSentinel(`HEAD ${SHA_A}\r\npkg/test_widget.py\r\n`);
    const data = await authorPlanAt(SHA_A);
    expect(data.intents.every((i) => i.status === 'skipped')).toBe(true);
    expect(data.intents[0]!.skip_reason ?? '').toContain('loop-guard');
  });
});
