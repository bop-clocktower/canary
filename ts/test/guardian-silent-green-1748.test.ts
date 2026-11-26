/**
 * #1748: two ways `guardian pr-check` went green over work it never checked.
 *
 * 1. A pytest `*_test.py` file was read as SOURCE, so a diff adding
 *    `pkg/calc_test.py` drew "no test file references calc_test" -- a test
 *    asked for its own test. `isTestPath` now shares the collector's
 *    file-name predicate (`isCollectedTestFile`), so the two layers cannot
 *    disagree about what a test is.
 * 2. Every exit-3 abstention looked the same. A docs-only diff (nothing to
 *    check, legitimately green) and a diff that changed a shell hook (code no
 *    coverage rung can reach) both printed one line and mapped to one warning,
 *    so the required check turned "verified nothing" into a tick on shipped
 *    code (#1738). The second case now names the files on its own greppable
 *    line, a `::notice`, the step summary and the JSON payload. The exit code
 *    is unchanged (still 3): whether that case should FAIL the check is a
 *    merge-policy decision left to the maintainer.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isCollectedTestFile } from '../src/core/test-files.js';
import { isTestPath } from '../src/guardian/coverage.js';
import {
  UNVERIFIED_CODE_MARKER,
  renderFindings,
  unverifiedCodePaths,
} from '../src/guardian/pr-check.js';
import { FakeGitHubClient } from '../src/guardian/pr-comment.js';
import { invokeGuardian, mkTmp, rmTmp } from './guardian-cli-testkit.js';

const ABSTAINED = 3;

/** A one-file added-lines diff. */
function addFile(path: string, lines: string[]): string {
  return (
    `diff --git a/${path} b/${path}\n` +
    `new file mode 100644\n` +
    `index 0000000..2222222\n` +
    `--- /dev/null\n` +
    `+++ b/${path}\n` +
    `@@ -0,0 +1,${lines.length} @@\n` +
    lines.map((l) => `+${l}\n`).join('')
  );
}

const DIFF_PY_TEST = addFile('pkg/calc_test.py', [
  'from pkg.calc import add',
  '',
  'def test_add():',
  '    assert add(1, 2) == 3',
]);
const DIFF_DOCS = addFile('docs/guide.md', ['# Guide', 'prose']);
const DIFF_HOOK = addFile('hooks/session-siren.sh', [
  '#!/bin/sh',
  'echo "siren"',
]);

let tmp: string;
beforeEach(() => {
  tmp = mkTmp();
});
afterEach(() => {
  rmTmp(tmp);
});

describe('isTestPath shares the collector predicate (#1748)', () => {
  it.each(['pkg/calc_test.py', 'calc_test.py', 'a/b/test_calc.py'])(
    'treats %s as a test',
    (path) => {
      expect(isTestPath(path)).toBe(true);
    },
  );

  it.each(['pkg/latest.py', 'pkg/contest.py', 'pkg/calc_test.pyc'])(
    'keeps %s as source',
    (path) => {
      expect(isTestPath(path)).toBe(false);
    },
  );

  it('never disagrees with the collector on a name the collector takes', () => {
    const names = [
      'test_a.py',
      'a_test.py',
      'a.test.ts',
      'a.spec.mjs',
      'a.test.cjs',
      'a.spec.tsx',
    ];
    for (const name of names) {
      expect(isCollectedTestFile(name)).toBe(true);
      expect(isTestPath(`src/deep/${name}`)).toBe(true);
    }
  });

  it('does not ask a *_test.py for its own test', async () => {
    const res = await invokeGuardian(['pr-check', '--diff', '-'], {
      input: DIFF_PY_TEST,
      cwd: tmp,
    });
    expect(res.stdout).not.toContain('no test file references calc_test');
    expect(res.stdout).toContain('pkg/calc_test.py [test path]');
    expect(res.code).toBe(ABSTAINED);
  });
});

describe('unverifiedCodePaths', () => {
  it('picks out non-source CODE, not data or docs', () => {
    expect(
      unverifiedCodePaths([
        { name: 'hooks/a.sh', reason: 'non-source' },
        { name: 'ops/b.ps1', reason: 'non-source' },
        { name: 'data/c.json', reason: 'non-source' },
        { name: 'docs/d.md', reason: 'skipGlobs' },
        { name: 'tests/e_test.py', reason: 'test path' },
      ]),
    ).toEqual(['hooks/a.sh', 'ops/b.ps1']);
  });

  it('is empty when nothing executable was dropped', () => {
    expect(unverifiedCodePaths([])).toEqual([]);
    expect(
      unverifiedCodePaths([{ name: 'ci/pipeline.yaml', reason: 'non-source' }]),
    ).toEqual([]);
  });
});

describe('pr-check splits the two abstentions (#1748)', () => {
  it('a docs-only diff abstains WITHOUT the unverified-code line', async () => {
    const summary = join(tmp, 'summary.md');
    writeFileSync(summary, '', 'utf-8');
    const res = await invokeGuardian(['pr-check', '--diff', '-'], {
      input: DIFF_DOCS,
      cwd: tmp,
      env: { GITHUB_STEP_SUMMARY: summary },
    });
    expect(res.code).toBe(ABSTAINED);
    expect(res.stdout).not.toContain(UNVERIFIED_CODE_MARKER);
    expect(res.stdout).not.toContain('::notice');
    expect(readFileSync(summary, 'utf-8')).not.toContain(
      UNVERIFIED_CODE_MARKER,
    );
  });

  it('a shell-hook diff names the unchecked file on every surface', async () => {
    const summary = join(tmp, 'summary.md');
    writeFileSync(summary, '', 'utf-8');
    const res = await invokeGuardian(['pr-check', '--diff', '-'], {
      input: DIFF_HOOK + DIFF_DOCS,
      cwd: tmp,
      env: { GITHUB_STEP_SUMMARY: summary },
    });
    // Exit code unchanged: the policy question is the maintainer's.
    expect(res.code).toBe(ABSTAINED);
    expect(res.stdout).toContain(
      `${UNVERIFIED_CODE_MARKER}: 1 changed code file(s) no coverage rung can check: hooks/session-siren.sh`,
    );
    expect(res.stdout).toMatch(
      /^::notice title=Guardian abstained on unverified code::.*hooks\/session-siren\.sh/m,
    );
    expect(readFileSync(summary, 'utf-8')).toContain(
      `${UNVERIFIED_CODE_MARKER}: 1 changed code file(s)`,
    );
  });

  it('json carries unverified_code on both kinds of abstention', async () => {
    const hook = await invokeGuardian(
      ['pr-check', '--diff', '-', '--format', 'json'],
      { input: DIFF_HOOK, cwd: tmp },
    );
    expect(hook.code).toBe(ABSTAINED);
    expect(JSON.parse(hook.stdout).unverified_code).toEqual([
      'hooks/session-siren.sh',
    ]);
    const docs = await invokeGuardian(
      ['pr-check', '--diff', '-', '--format', 'json'],
      { input: DIFF_DOCS, cwd: tmp },
    );
    expect(JSON.parse(docs.stdout).unverified_code).toEqual([]);
  });

  it('the sticky does not call a changed shell hook "nothing to test"', async () => {
    const fake = new FakeGitHubClient();
    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--post-comment'],
      {
        input: DIFF_HOOK,
        cwd: tmp,
        env: { GITHUB_REPOSITORY: 'o/r', GITHUB_REF: 'refs/pull/7/merge' },
        deps: { buildCommentClient: () => fake },
      },
    );
    expect(res.code).toBe(ABSTAINED);
    expect(fake.comments).toHaveLength(1);
    const body = fake.comments[0]!.body;
    expect(body).not.toContain('nothing to test');
    expect(body).toContain('not verified: 1 changed code file');
    expect(body).toContain('hooks/session-siren.sh');
  });
});

describe('renderFindings comment headline', () => {
  const coverage = {
    requested: null,
    found: false,
    parsed: false,
    filesInReport: 0,
    unitsMatched: 0,
    unitsTotal: 0,
  };

  it('keeps the nothing-to-test headline when no code was dropped', () => {
    const body = renderFindings([], 'comment', 0, null, {
      checked: 0,
      abstained: false,
      coverage,
      skipped: [{ name: 'docs/a.md', reason: 'skipGlobs' }],
    });
    expect(body).toContain('nothing to test: no source files changed');
  });
});
