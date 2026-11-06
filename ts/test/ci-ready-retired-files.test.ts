/**
 * #1500: ci-ready's flakiness check keeps scoring a deleted test file until its
 * runs age out of the window, so a red lands on PRs that never touched it.
 *
 * Retirement is FILE-level, by human decision: a test-level join against the
 * inventory wrongly retired 23% of live rows on canary's own suite, because the
 * inventory cannot see `it.each` or loop-generated titles. A row retires only
 * when ALL hold: its file is not in the inventory, its file name is one the
 * inventory collects, and a sibling in its directory is live.
 *
 * Every miss here is meant to be a false FAIL (still scored), never a false
 * green, and the cases that stay scored are pinned as carefully as the ones
 * that retire.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scoreCiReady, type CiCheck } from '../src/core/ci-ready.js';
import { retirementNotes } from '../src/core/flakiness-check.js';
import { isCollectedTestFile } from '../src/core/test-files.js';
import {
  parseCriticalAreas,
  parseInventory,
  type InventoryInput,
} from '../src/core/inventory-checks.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

const DELETED = 'tests/checkout.spec.ts';
const LIVE = 'tests/cart.spec.ts';

interface Row {
  test_name: string;
  test_file?: string;
  status: string;
}

interface Run {
  suite: string;
  timestamp: string;
  reporter_format: string;
  tests: Row[];
}

function hour(n: number): string {
  return new Date(Date.UTC(2026, 9, 1) + n * 3_600_000).toISOString();
}

/** 27 runs: `row(i)` supplies each run's rows, oldest first. */
function runs(row: (i: number) => Row[], count = 27, suite = 'api'): Run[] {
  return Array.from({ length: count }, (_, i) => ({
    suite,
    timestamp: hour(i),
    reporter_format: 'playwright',
    tests: row(i),
  }));
}

/** A test that flaked in 4 of 27 runs (the issue's fixture). */
function flaked(file: string | undefined, name = 'pays', i = 0): Row {
  return {
    test_name: name,
    ...(file === undefined ? {} : { test_file: file }),
    status: i < 4 ? 'flaky' : 'passed',
  };
}

function clean(file: string, name = 'adds'): Row {
  return { test_name: name, test_file: file, status: 'passed' };
}

function inventoryOf(
  paths: string[],
  extra: {
    skipped?: { name: string; reason: string }[];
    generated?: string;
  } = {},
): InventoryInput {
  return parseInventory(
    JSON.stringify({
      schema_version: 1,
      generated: extra.generated ?? hour(1000),
      files: paths.map((path) => ({
        path,
        framework: 'playwright',
        targets: [],
        tests: [{ name: 't', line: 1, depth: 2 }],
      })),
      skipped: extra.skipped ?? [],
    }),
  );
}

function score(history: Run[], inventory: InventoryInput) {
  const report = scoreCiReady({
    runs: history,
    historyPath: 'history-v2.jsonl',
    inventory,
    criticalAreas: parseCriticalAreas(null),
  });
  const flakiness: CiCheck = report.checks.find((c) => c.name === 'flakiness')!;
  return { report, flakiness, retirement: report.retirement! };
}

/** A deleted file's flaky rows next to a clean, live sibling. */
const issueHistory = (): Run[] =>
  runs((i) => [flaked(DELETED, 'pays', i), clean(LIVE)]);

describe('#1500 flakiness retires deleted test files', () => {
  describe('the issue case', () => {
    it('stops scoring a deleted file and names what it retired', () => {
      const { flakiness, retirement } = score(
        issueHistory(),
        inventoryOf([LIVE]),
      );
      expect(flakiness.verdict).toBe('pass');
      expect(flakiness.reason).toBe(
        '0 flaky or alternating tests across 27 run(s) (window 30); ' +
          `1 retired test(s) excluded (${DELETED} \u{203A} pays, was 15% on retry-flake)`,
      );
      expect(retirement.applied).toBe(true);
      expect(retirement.retired_count).toBe(1);
      expect(retirement.retired).toEqual([
        {
          suite: 'api',
          file: DELETED,
          title: 'pays',
          rate: 4 / 27,
          axis: 'retry-flake',
        },
      ]);
    });

    it('still fails the same history when the file is live (control)', () => {
      const { flakiness, retirement } = score(
        issueHistory(),
        inventoryOf([LIVE, DELETED]),
      );
      expect(flakiness.verdict).toBe('fail');
      expect(flakiness.reason).toBe(
        '1 flaky or alternating test(s) across 27 run(s) (window 30); ' +
          'worst is pays at 15% on retry-flake',
      );
      expect(retirement.retired_count).toBe(0);
    });

    it('names a retired test that never flaked, with a zero rate', () => {
      const { retirement } = score(
        runs(() => [clean(DELETED, 'quiet'), clean(LIVE)]),
        inventoryOf([LIVE]),
      );
      expect(retirement.retired).toEqual([
        { suite: 'api', file: DELETED, title: 'quiet', rate: 0, axis: null },
      ]);
    });

    it('still names a live flake beside a retired one', () => {
      const { flakiness } = score(
        runs((i) => [flaked(DELETED, 'gone', i), flaked(LIVE, 'stays', i)]),
        inventoryOf([LIVE]),
      );
      expect(flakiness.verdict).toBe('fail');
      expect(flakiness.reason).toContain(
        'worst is stays at 15% on retry-flake',
      );
      expect(flakiness.reason).toContain('1 retired test(s) excluded');
    });

    it('does not merge same-named tests from a live and a deleted file', () => {
      const { flakiness, retirement } = score(
        runs((i) => [flaked(DELETED, 'same', i), clean(LIVE, 'same')]),
        inventoryOf([LIVE]),
      );
      expect(flakiness.verdict).toBe('pass');
      expect(retirement.retired.map((r) => r.file)).toEqual([DELETED]);
    });

    it('scores each suite against its own files', () => {
      const history = [
        ...runs((i) => [flaked(DELETED, 'pays', i), clean(LIVE)], 27, 'api'),
        // The other suite has no live sibling for the same deleted file.
        ...runs((i) => [flaked(DELETED, 'pays', i)], 27, 'web'),
      ];
      const { flakiness, retirement } = score(history, inventoryOf([LIVE]));
      expect(flakiness.verdict).toBe('fail');
      expect(flakiness.reason).toContain('worst is pays in web at 15%');
      expect(retirement.retired.map((r) => r.suite)).toEqual(['api']);
      expect(retirement.kept).toEqual([
        { suite: 'web', file: DELETED, why: 'no-live-sibling' },
      ]);
    });

    it('does not count a run left with no live row toward the sample floor', () => {
      // 27 runs of only the deleted file, 2 with the live one: 2 measured runs.
      const history = [
        ...runs(() => [clean(DELETED)], 27),
        ...runs(() => [clean(LIVE)], 2).map((r, i) => ({
          ...r,
          timestamp: hour(100 + i),
        })),
      ];
      const { flakiness } = score(history, inventoryOf([LIVE]));
      expect(flakiness.verdict).toBe('warn');
      expect(flakiness.reason).toContain('insufficient history: 2 of 10 runs');
    });
  });

  describe('guards: what stays scored', () => {
    it('keeps live files outside a scoped inventory scored (sibling guard)', () => {
      // `canary inventory test/` lists nothing under src/, whose tests are live.
      const scoped = 'src/core/parser.test.ts';
      const { flakiness, retirement } = score(
        runs((i) => [flaked(scoped, 'parses', i), clean('test/a.test.ts')]),
        inventoryOf(['test/a.test.ts']),
      );
      expect(flakiness.verdict).toBe('fail');
      expect(retirement.retired).toEqual([]);
      expect(retirement.kept).toEqual([
        { suite: 'api', file: scoped, why: 'no-live-sibling' },
      ]);
    });

    it('keeps the last file in a directory scored (no live sibling)', () => {
      const { flakiness, retirement } = score(
        runs((i) => [flaked('tests/only/one.spec.ts', 'x', i), clean(LIVE)]),
        inventoryOf([LIVE]),
      );
      expect(flakiness.verdict).toBe('fail');
      expect(retirement.retired_count).toBe(0);
    });

    it.each(['tests/foo_test.py', 'tests/x.e2e.ts', 'tests/conftest.py'])(
      'keeps %s scored: the inventory never collects that name (name guard)',
      (file) => {
        const { flakiness, retirement } = score(
          runs((i) => [flaked(file, 'x', i), clean(LIVE)]),
          inventoryOf([LIVE]),
        );
        expect(flakiness.verdict).toBe('fail');
        expect(retirement.retired).toEqual([]);
        expect(retirement.kept).toEqual([
          { suite: 'api', file, why: 'uncollected-name' },
        ]);
      },
    );

    it('keeps a file listed as skipped scored: unreadable is not deleted', () => {
      const { flakiness, retirement } = score(
        issueHistory(),
        inventoryOf([LIVE], {
          skipped: [{ name: DELETED, reason: 'unreadable: EACCES' }],
        }),
      );
      expect(flakiness.verdict).toBe('fail');
      expect(retirement.retired).toEqual([]);
      expect(retirement.kept).toEqual([]);
    });

    it('keeps a directory scored when most of it is missing', () => {
      // One colliding path is not evidence about a whole directory. An inventory
      // of another package, with its own test/shared.test.ts, joined 3 of 61
      // stored files and wrongly retired the other 58 on real data before this.
      const dir = '/repo/other/test';
      const { flakiness, retirement } = score(
        runs((i) => [
          clean(`${dir}/shared.test.ts`),
          flaked(`${dir}/a.test.ts`, 'a', i),
          clean(`${dir}/b.test.ts`, 'b'),
        ]),
        inventoryOf(['test/shared.test.ts']),
      );
      expect(flakiness.verdict).toBe('fail');
      expect(retirement.retired).toEqual([]);
      expect(retirement.kept.map((k) => k.why)).toEqual([
        'mostly-missing-directory',
        'mostly-missing-directory',
      ]);
    });

    it('retires when as many siblings are live as are missing', () => {
      const { retirement } = score(
        runs((i) => [
          flaked('t/a.test.ts', 'a', i),
          flaked('t/b.test.ts', 'b', i),
          clean('t/c.test.ts'),
          clean('t/d.test.ts'),
        ]),
        inventoryOf(['t/c.test.ts', 't/d.test.ts']),
      );
      expect(retirement.retired.map((r) => r.file).sort()).toEqual([
        't/a.test.ts',
        't/b.test.ts',
      ]);
    });

    it('keeps a file that ran after the inventory was written scored', () => {
      // A stale inventory has no way to list a file newer than itself, and a
      // file that ran after it cannot have been deleted before it.
      const { flakiness, retirement } = score(
        issueHistory(),
        inventoryOf([LIVE], { generated: hour(10) }),
      );
      expect(flakiness.verdict).toBe('fail');
      expect(retirement.retired).toEqual([]);
      expect(retirement.kept).toEqual([
        { suite: 'api', file: DELETED, why: 'ran-after-inventory' },
      ]);
    });

    it('keeps rows with no test_file scored and counts them as unmatched', () => {
      const { flakiness, retirement } = score(
        runs((i) => [flaked(undefined, 'orphan', i), clean(LIVE)]),
        inventoryOf([LIVE]),
      );
      expect(flakiness.verdict).toBe('fail');
      expect(retirement.retired).toEqual([]);
      expect(retirement.unmatched_rows).toBe(27);
    });

    it('keeps a test deleted from a surviving file scored (known false fail)', () => {
      // File-level by decision: the file still exists, so nothing can retire.
      const { flakiness, retirement } = score(
        runs((i) => [flaked(LIVE, 'removed from a live file', i)]),
        inventoryOf([LIVE]),
      );
      expect(flakiness.verdict).toBe('fail');
      expect(retirement.retired).toEqual([]);
      expect(retirement.kept).toEqual([]);
    });
  });

  describe('joining stored paths to the inventory', () => {
    it.each([
      [
        'absolute (vitest)',
        '/ci/repo/tests/cart.spec.ts',
        '/ci/repo/tests/x.spec.ts',
      ],
      ['testDir-relative (Playwright)', 'cart.spec.ts', 'x.spec.ts'],
      [
        'windows separators',
        'C:\\ci\\tests\\cart.spec.ts',
        'C:\\ci\\tests\\x.spec.ts',
      ],
      ['leading dot-slash', './tests/cart.spec.ts', './tests/x.spec.ts'],
    ])('retires across a %s stored path base', (_label, live, gone) => {
      const { flakiness, retirement } = score(
        runs((i) => [flaked(gone, 'x', i), clean(live)]),
        inventoryOf(['tests/cart.spec.ts']),
      );
      expect(flakiness.verdict).toBe('pass');
      expect(retirement.retired.map((r) => r.file)).toEqual([gone]);
    });

    it('does not treat a name that merely ends the same as a join', () => {
      // "xcart.spec.ts" must not join "cart.spec.ts": a false join here would
      // make a deleted file look live, or hand a directory a bogus live sibling.
      const { retirement } = score(
        runs((i) => [
          flaked('e2e/old.spec.ts', 'x', i),
          clean('e2e/xcart.spec.ts'),
        ]),
        inventoryOf(['cart.spec.ts']),
      );
      expect(retirement.retired).toEqual([]);
    });

    it('joins on whole path segments, not on a string suffix', () => {
      // "xtests/cart.spec.ts" must not join "tests/cart.spec.ts": that bogus
      // join is the only live sibling "xtests/old.spec.ts" would have.
      const { retirement } = score(
        runs((i) => [
          flaked('/ci/xtests/old.spec.ts', 'x', i),
          clean('/ci/xtests/cart.spec.ts'),
        ]),
        inventoryOf(['tests/cart.spec.ts']),
      );
      expect(retirement.retired).toEqual([]);
    });
  });

  describe('abstaining', () => {
    it.each([
      ['missing', parseInventory(null), 'no .canary/test-inventory.json'],
      ['unusable', { ok: false as const, reason: 'broken' }, 'broken'],
      ['empty', inventoryOf([]), 'lists no tests'],
      [
        'skipped only',
        parseInventory(
          JSON.stringify({
            schema_version: 1,
            files: [],
            skipped: [{ name: LIVE, reason: 'unreadable' }],
          }),
        ),
        'lists no tests',
      ],
    ])('scores as today on a %s inventory and says so', (_l, input, why) => {
      const { flakiness, retirement } = score(issueHistory(), input);
      expect(flakiness).toEqual({
        name: 'flakiness',
        verdict: 'fail',
        reason:
          '1 flaky or alternating test(s) across 27 run(s) (window 30); ' +
          'worst is pays at 15% on retry-flake',
        measure: { value: 4 / 27, unit: 'ratio', denominator: 27 },
      });
      expect(retirement.applied).toBe(false);
      expect(retirement.reason).toContain(why);
      expect(retirement.retired_count).toBe(0);
    });

    it('has nothing to report when there is no history to score', () => {
      const report = scoreCiReady({
        runs: null,
        historyPath: 'h',
        inventory: inventoryOf([LIVE]),
        criticalAreas: parseCriticalAreas(null),
      });
      expect(report.retirement).toBeNull();
    });
  });

  describe('a usable inventory that retires nothing', () => {
    it('leaves the reason byte-identical', () => {
      const { flakiness } = score(
        runs(() => [clean(LIVE)]),
        inventoryOf([LIVE]),
      );
      expect(flakiness).toEqual({
        name: 'flakiness',
        verdict: 'pass',
        reason: '0 flaky or alternating tests across 27 run(s) (window 30)',
        measure: { value: 0, unit: 'ratio', denominator: 27 },
      });
    });
  });

  describe('retirementNotes', () => {
    it('caps the files it names, because a scoped inventory can keep hundreds', () => {
      const files = Array.from({ length: 7 }, (_, i) => `d${i}/t${i}.test.ts`);
      const { retirement } = score(
        runs(() => [...files.map((f) => clean(f)), clean(LIVE)]),
        inventoryOf([LIVE]),
      );
      expect(retirement.kept).toHaveLength(7);
      const [note] = retirementNotes(retirement);
      expect(note).toContain('7 file(s) missing from the inventory');
      expect(note).toContain('d4/t4.test.ts: no-live-sibling, and 2 more).');
      expect(note).not.toContain('d5/t5.test.ts');
    });

    it('has nothing to say when retirement applied and nothing stayed', () => {
      const { retirement } = score(
        runs(() => [clean(LIVE)]),
        inventoryOf([LIVE]),
      );
      expect(retirementNotes(retirement)).toEqual([]);
      expect(retirementNotes(null)).toEqual([]);
    });
  });

  describe('isCollectedTestFile', () => {
    it.each([
      ['a.test.ts', true],
      ['a.spec.mjs', true],
      ['a.test.tsx', true],
      ['test_a.py', true],
      ['a_test.py', false],
      ['a.e2e.ts', false],
      ['conftest.py', false],
      ['a.test.rb', false],
    ])('%s -> %s', (name, expected) => {
      expect(isCollectedTestFile(name)).toBe(expected);
    });
  });

  describe('through the CLI', () => {
    let root: string;
    beforeEach(() => {
      root = mkTmp();
    });
    afterEach(() => {
      rmTmp(root);
    });

    function seed(testFiles: string[], history: Run[]): void {
      for (const f of testFiles) {
        mkdirSync(join(root, f, '..'), { recursive: true });
        writeFileSync(
          join(root, f),
          "import { it, expect } from 'vitest';\nit('t', () => { expect(1).toBe(1); });\n",
        );
      }
      const dir = join(root, 'test-results', 'reports');
      mkdirSync(dir, { recursive: true });
      const lines = history.map((r, i) =>
        JSON.stringify({
          run_id: `r${i}`,
          branch: 'main',
          commit_sha: 'abc',
          total: r.tests.length,
          passed: 0,
          failed: 0,
          flaky: 0,
          skipped: 0,
          schema_version: 2,
          ...r,
        }),
      );
      writeFileSync(join(dir, 'history-v2.jsonl'), lines.join('\n') + '\n');
    }

    it('retires a file a real `canary inventory` no longer lists', async () => {
      seed([LIVE], issueHistory());
      await invokeCanary(['inventory', '--root', root]);
      const res = await invokeCanary(['ci-ready', '--root', root, '--json']);
      const report = JSON.parse(res.stdout) as {
        checks: CiCheck[];
        retirement: { retired_count: number; retired: { file: string }[] };
      };
      const f = report.checks.find((c) => c.name === 'flakiness')!;
      expect(f.verdict).toBe('pass');
      expect(report.retirement.retired_count).toBe(1);
      expect(report.retirement.retired[0]!.file).toBe(DELETED);
    });

    it('prints the not-applied note in text output, without an inventory', async () => {
      seed([LIVE], issueHistory());
      const res = await invokeCanary(['ci-ready', '--root', root]);
      expect(res.stdout).toContain(
        'Flakiness retirement not applied: no .canary/test-inventory.json',
      );
      expect(res.code).toBe(1);
    });

    it('prints what stayed scored in text output', async () => {
      seed(
        [LIVE],
        runs((i) => [
          flaked('tests/foo_test.py', 'x', i),
          flaked(undefined, 'y', i),
          clean(LIVE),
        ]),
      );
      await invokeCanary(['inventory', '--root', root]);
      const res = await invokeCanary(['ci-ready', '--root', root]);
      expect(res.stdout).toContain(
        'Flakiness retirement: 27 row(s) with no test_file stayed scored',
      );
      expect(res.stdout).toContain(
        '1 file(s) missing from the inventory stayed scored (tests/foo_test.py: uncollected-name)',
      );
    });
  });
});
