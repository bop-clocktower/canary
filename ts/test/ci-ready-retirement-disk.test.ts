/**
 * #1561: the follow-up review of #1500's file-level retirement. Every guard in
 * #1500 trusted the inventory, and none asked whether the file was really
 * gone, so five ways a LIVE test left the flakiness score were reproduced
 * with the real CLI:
 *
 * - F1, a stale inventory (`.canary/` is gitignored, so it survives a branch
 *   switch) retired a test file that is on disk;
 * - a same-named file in another package joined 1:1;
 * - a bare stored name (Playwright with `testDir` at the file's directory);
 * - a symlinked test, which the inventory's walk does not collect;
 * - F2, a renamed file, whose old rows retire while the title lives on.
 *
 * The first four are cured by the sixth guard: a row retires only when its
 * file is ALSO absent from the working tree. F2 is not a false retirement --
 * the old file really is gone -- so by human decision it stays retired and is
 * named in a warning instead.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  scoreCiReady,
  workingTreeAt,
  type CiCheck,
} from '../src/core/ci-ready.js';
import { retirementNotes } from '../src/core/flakiness-check.js';
import type { WorkingTree } from '../src/core/working-tree.js';
import {
  parseCriticalAreas,
  parseInventory,
  type InventoryInput,
} from '../src/core/inventory-checks.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

const LIVE = 'tests/cart.spec.ts';
const NEW = 'tests/new.spec.ts';
const DELETED = 'tests/checkout.spec.ts';

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

function runs(row: (i: number) => Row[], count = 27): Run[] {
  return Array.from({ length: count }, (_, i) => ({
    suite: 'api',
    timestamp: hour(i),
    reporter_format: 'playwright',
    tests: row(i),
  }));
}

/** Flaky in the first `flakes` of the runs (4 of 27 is 15%). */
function flaked(file: string | undefined, name: string, i: number, flakes = 4) {
  return {
    test_name: name,
    ...(file === undefined ? {} : { test_file: file }),
    status: i < flakes ? 'flaky' : 'passed',
  };
}

function clean(file: string, name = 'adds'): Row {
  return { test_name: name, test_file: file, status: 'passed' };
}

/** An inventory written AFTER every run here, so no ran-after guard fires. */
function inventoryOf(paths: string[]): InventoryInput {
  return parseInventory(
    JSON.stringify({
      schema_version: 1,
      generated: hour(1000),
      files: paths.map((path) => ({
        path,
        framework: 'playwright',
        targets: [],
        tests: [{ name: 't', line: 1, depth: 2 }],
      })),
      skipped: [],
    }),
  );
}

/** A working tree holding `files` (root-relative) and nothing else. */
function treeOf(files: string[], exists: string[] = files): WorkingTree {
  return {
    exists: (p) => exists.includes(p),
    testFiles: () => files,
  };
}

function score(
  history: Run[],
  inventory: InventoryInput,
  workingTree: WorkingTree | null,
) {
  const report = scoreCiReady({
    runs: history,
    historyPath: 'history-v2.jsonl',
    inventory,
    criticalAreas: parseCriticalAreas(null),
    workingTree,
  });
  const flakiness: CiCheck = report.checks.find((c) => c.name === 'flakiness')!;
  return { report, flakiness, retirement: report.retirement! };
}

describe('#1561 the working-tree guard', () => {
  it('F1: keeps a file the stale inventory omits scored when it is on disk', () => {
    const { flakiness, retirement } = score(
      runs((i) => [flaked(NEW, 'new flake', i), clean(LIVE)]),
      inventoryOf([LIVE]),
      treeOf([LIVE, NEW]),
    );
    expect(flakiness.verdict).toBe('fail');
    expect(flakiness.reason).toBe(
      '1 flaky or alternating test(s) across 27 run(s) (window 30); ' +
        'worst is new flake at 15% on retry-flake',
    );
    expect(retirement.retired).toEqual([]);
    expect(retirement.kept).toEqual([
      { suite: 'api', file: NEW, why: 'present-on-disk' },
    ]);
  });

  it('still retires a file that is gone from the inventory AND the disk', () => {
    const { flakiness, retirement } = score(
      runs((i) => [flaked(DELETED, 'pays', i), clean(LIVE)]),
      inventoryOf([LIVE]),
      treeOf([LIVE]),
    );
    expect(flakiness.verdict).toBe('pass');
    expect(retirement.retired.map((r) => r.file)).toEqual([DELETED]);
  });

  it('keeps a file whose stored path exists, though no walked file joins it', () => {
    // Another package's rows on this machine: stored absolute, and the file is
    // there, even though this root's walk never reaches it.
    const other = '/repo/pkgA/test/live.test.ts';
    const { flakiness, retirement } = score(
      runs((i) => [
        clean('/repo/pkgA/test/shared.test.ts', 'shared'),
        flaked(other, 'live flake', i),
      ]),
      inventoryOf(['test/shared.test.ts']),
      treeOf(['test/shared.test.ts'], [other]),
    );
    expect(flakiness.verdict).toBe('fail');
    expect(retirement.kept).toEqual([
      { suite: 'api', file: other, why: 'present-on-disk' },
    ]);
  });

  it('keeps a bare stored name scored while any same-named file is on disk', () => {
    const { flakiness, retirement } = score(
      runs((i) => [clean('a.spec.ts', 'a'), flaked('b.spec.ts', 'b', i)]),
      inventoryOf(['other/a.spec.ts']),
      treeOf(['other/a.spec.ts', 'e2e/a.spec.ts', 'e2e/b.spec.ts'], []),
    );
    expect(flakiness.verdict).toBe('fail');
    expect(retirement.kept).toEqual([
      { suite: 'api', file: 'b.spec.ts', why: 'present-on-disk' },
    ]);
  });

  it('joins the disk on whole path segments, as it joins the inventory', () => {
    // "xtests/new.spec.ts" on disk is not "tests/new.spec.ts".
    const { retirement } = score(
      runs((i) => [flaked(NEW, 'gone', i), clean(LIVE)]),
      inventoryOf([LIVE]),
      treeOf([LIVE, 'xtests/new.spec.ts'], []),
    );
    expect(retirement.retired.map((r) => r.file)).toEqual([NEW]);
  });

  it('does not walk the disk when the inventory guards retire nothing', () => {
    let walks = 0;
    let probes = 0;
    const counting: WorkingTree = {
      exists: () => (probes++, false),
      testFiles: () => (walks++, []),
    };
    score(
      runs(() => [clean(LIVE)]),
      inventoryOf([LIVE]),
      counting,
    );
    expect({ walks, probes }).toEqual({ walks: 0, probes: 0 });
  });

  it('walks the disk at most once however many files it checks', () => {
    let walks = 0;
    const counting: WorkingTree = {
      exists: () => false,
      testFiles: () => (walks++, [LIVE]),
    };
    score(
      runs(() => [
        clean('tests/a.spec.ts'),
        clean('tests/b.spec.ts'),
        clean(LIVE, 'c'),
        clean('tests/d.spec.ts', 'd'),
      ]),
      inventoryOf([LIVE, 'tests/d.spec.ts']),
      counting,
    );
    expect(walks).toBe(1);
  });

  it('does not apply retirement without a working tree to check', () => {
    const { flakiness, retirement } = score(
      runs((i) => [flaked(DELETED, 'pays', i), clean(LIVE)]),
      inventoryOf([LIVE]),
      null,
    );
    expect(flakiness.verdict).toBe('fail');
    expect(retirement.applied).toBe(false);
    expect(retirement.reason).toBe('the working tree was not checked');
    expect(retirementNotes(retirement)).toEqual([
      'Flakiness retirement not applied: the working tree was not checked; tests from deleted files keep scoring until they age out.',
    ]);
  });

  describe('workingTreeAt', () => {
    let root: string;
    beforeEach(() => {
      root = mkTmp();
    });
    afterEach(() => {
      rmTmp(root);
    });

    it('lists collected test files root-relative, symlinks to files included', () => {
      mkdirSync(join(root, 'tests'), { recursive: true });
      mkdirSync(join(root, 'shared'), { recursive: true });
      mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
      writeFileSync(join(root, 'tests', 'cart.spec.ts'), '');
      writeFileSync(join(root, 'tests', 'helper.ts'), '');
      writeFileSync(join(root, 'shared', 'linked.spec.ts'), '');
      writeFileSync(join(root, 'node_modules', 'dep', 'x.test.ts'), '');
      symlinkSync(
        join('..', 'shared', 'linked.spec.ts'),
        join(root, 'tests', 'linked.spec.ts'),
      );
      // A dangling link is not a file on disk.
      symlinkSync('missing.spec.ts', join(root, 'tests', 'dangling.spec.ts'));
      const tree = workingTreeAt(root);
      expect([...tree.testFiles()].sort()).toEqual([
        'shared/linked.spec.ts',
        'tests/cart.spec.ts',
        'tests/linked.spec.ts',
      ]);
    });

    it('answers exists() for root-relative and absolute paths', () => {
      mkdirSync(join(root, 'tests'), { recursive: true });
      writeFileSync(join(root, 'tests', 'cart.spec.ts'), '');
      const tree = workingTreeAt(root);
      expect(tree.exists('tests/cart.spec.ts')).toBe(true);
      expect(tree.exists(join(root, 'tests', 'cart.spec.ts'))).toBe(true);
      expect(tree.exists('tests/gone.spec.ts')).toBe(false);
      expect(tree.exists(join(root, 'tests', 'gone.spec.ts'))).toBe(false);
    });
  });
});

describe('#1561 F2: a retired title that lives on in another file', () => {
  const PAY = 'tests/pay.spec.ts';
  const PAYMENT = 'tests/payment.spec.ts';
  const TITLE = 'charges the card';
  /** 25 runs of the old file, flaky 4 times (16%), then 5 of the new one. */
  const renamed = (): Run[] =>
    runs(
      (i) =>
        i < 25
          ? [flaked(PAY, TITLE, i), clean(LIVE)]
          : [clean(PAYMENT, TITLE), clean(LIVE)],
      30,
    );

  it('keeps the retirement and names where the title still lives', () => {
    const { flakiness, retirement } = score(
      renamed(),
      inventoryOf([LIVE, PAYMENT]),
      treeOf([LIVE, PAYMENT]),
    );
    expect(flakiness.verdict).toBe('pass');
    expect(retirement.retired.map((r) => r.file)).toEqual([PAY]);
    expect(retirement.title_matches).toEqual([
      { suite: 'api', file: PAY, title: TITLE, live_files: [PAYMENT] },
    ]);
    expect(retirementNotes(retirement)).toEqual([
      `Flakiness retirement warning: 1 retired test(s) share a title with a live file, so a rename may have taken live history with it (retired ${PAY} \u{203A} ${TITLE}, but the same title exists in ${PAYMENT}).`,
    ]);
  });

  it('does not warn when the title lives on nowhere', () => {
    const { retirement } = score(
      runs((i) => [flaked(PAY, TITLE, i), clean(LIVE)]),
      inventoryOf([LIVE]),
      treeOf([LIVE]),
    );
    expect(retirement.retired_count).toBe(1);
    expect(retirement.title_matches).toEqual([]);
    expect(retirementNotes(retirement)).toEqual([]);
  });

  it('does not count another retired file as where the title lives', () => {
    const { retirement } = score(
      runs((i) => [
        flaked(PAY, TITLE, i),
        clean('tests/pay2.spec.ts', TITLE),
        clean(LIVE),
        clean('tests/d.spec.ts', 'd'),
      ]),
      inventoryOf([LIVE, 'tests/d.spec.ts']),
      treeOf([LIVE, 'tests/d.spec.ts']),
    );
    expect(retirement.retired_count).toBe(2);
    expect(retirement.title_matches).toEqual([]);
  });

  it('looks for the title in the same suite only', () => {
    const history = [
      ...runs((i) => [flaked(PAY, TITLE, i), clean(LIVE)]),
      ...runs(() => [clean(PAYMENT, TITLE)]).map((r) => ({
        ...r,
        suite: 'web',
      })),
    ];
    const { retirement } = score(
      history,
      inventoryOf([LIVE, PAYMENT]),
      treeOf([LIVE, PAYMENT]),
    );
    expect(retirement.title_matches).toEqual([]);
  });
});

describe('#1561 test gaps in #1500', () => {
  it('scores rows with no test_file beside a retirement', () => {
    const { flakiness, retirement } = score(
      runs((i) => [
        flaked(DELETED, 'gone', i),
        flaked(undefined, 'orphan', i, 3),
        clean(LIVE),
      ]),
      inventoryOf([LIVE]),
      treeOf([LIVE]),
    );
    expect(retirement.retired.map((r) => r.title)).toEqual(['gone']);
    expect(retirement.unmatched_rows).toBe(27);
    expect(flakiness.verdict).toBe('fail');
    expect(flakiness.reason).toContain('worst is orphan at 11% on retry-flake');
  });

  it('does not join a listed path that merely ends with the stored one', () => {
    // Listed "pkg/xtests/cart.spec.ts" is not stored "tests/cart.spec.ts", so
    // tests/ has no live sibling and tests/old.spec.ts must stay scored.
    const { retirement } = score(
      runs((i) => [flaked('tests/old.spec.ts', 'x', i), clean(LIVE)]),
      inventoryOf(['pkg/xtests/cart.spec.ts']),
      treeOf([]),
    );
    expect(retirement.retired).toEqual([]);
    expect(retirement.kept.map((k) => k.why)).toEqual([
      'no-live-sibling',
      'no-live-sibling',
    ]);
  });

  it('sorts retired tests worst first, and the reason names the worst', () => {
    const { flakiness, retirement } = score(
      runs((i) => [
        flaked('tests/mild.spec.ts', 'mild', i, 3),
        flaked('tests/bad.spec.ts', 'bad', i, 8),
        clean('tests/quiet.spec.ts', 'quiet'),
        clean(LIVE),
        clean('tests/b.spec.ts', 'b'),
        clean('tests/c.spec.ts', 'c'),
      ]),
      inventoryOf([LIVE, 'tests/b.spec.ts', 'tests/c.spec.ts']),
      treeOf([LIVE, 'tests/b.spec.ts', 'tests/c.spec.ts']),
    );
    expect(retirement.retired.map((r) => r.title)).toEqual([
      'bad',
      'mild',
      'quiet',
    ]);
    expect(flakiness.reason).toContain(
      '3 retired test(s) excluded (tests/bad.spec.ts \u{203A} bad, was 30% on retry-flake)',
    );
  });
});

describe('#1561 through the real CLI', () => {
  let root: string;
  beforeEach(() => {
    root = mkTmp();
  });
  afterEach(() => {
    rmTmp(root);
  });

  const TEST_BODY =
    "import { it, expect } from 'vitest';\nit('t', () => { expect(1).toBe(1); });\n";

  function write(at: string, file: string): void {
    mkdirSync(join(at, file, '..'), { recursive: true });
    writeFileSync(join(at, file), TEST_BODY);
  }

  function writeHistory(at: string, history: Run[]): void {
    const dir = join(at, 'test-results', 'reports');
    mkdirSync(dir, { recursive: true });
    const lines = history.map((r, i) =>
      JSON.stringify({
        run_id: `r${i}`,
        branch: 'feat',
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

  async function ciReady(at: string) {
    const res = await invokeCanary(['ci-ready', '--root', at, '--json']);
    const report = JSON.parse(res.stdout) as {
      checks: CiCheck[];
      retirement: {
        retired: { file: string }[];
        kept: { file: string; why: string }[];
      };
    };
    const flakiness = report.checks.find((c) => c.name === 'flakiness')!;
    return { code: res.code, flakiness, retirement: report.retirement };
  }

  it("F1: #1561's sequence reads fail, exit 1, on a stale inventory", async () => {
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'f1@example.invalid');
    git('config', 'user.name', 'f1');
    writeFileSync(join(root, '.gitignore'), '.canary/\ntest-results/\n');
    write(root, LIVE);
    git('add', '.');
    git('commit', '-qm', 'main');
    git('checkout', '-qb', 'feat');
    write(root, NEW);
    git('add', '.');
    git('commit', '-qm', 'feat');
    writeHistory(
      root,
      runs((i) => [flaked(NEW, 'new flake', i), clean(LIVE)]),
    );
    git('checkout', '-q', 'main');
    await invokeCanary(['inventory', '--root', root]);
    git('checkout', '-q', 'feat');

    const { code, flakiness, retirement } = await ciReady(root);
    expect(flakiness.verdict).toBe('fail');
    expect(code).toBe(1);
    expect(retirement.retired).toEqual([]);
    expect(retirement.kept).toEqual([
      { suite: 'api', file: NEW, why: 'present-on-disk' },
    ]);
  });

  it('keeps a live symlinked test scored', async () => {
    write(root, LIVE);
    write(root, 'shared/linked.spec.ts');
    symlinkSync(
      join('..', 'shared', 'linked.spec.ts'),
      join(root, 'tests', 'linked.spec.ts'),
    );
    writeHistory(
      root,
      runs((i) => [clean(LIVE), flaked('tests/linked.spec.ts', 'link', i)]),
    );
    await invokeCanary(['inventory', '--root', root]);
    const { code, flakiness } = await ciReady(root);
    expect(flakiness.verdict).toBe('fail');
    expect(code).toBe(1);
  });

  it("keeps another package's live rows scored at a 1:1 name match", async () => {
    const pkgA = join(root, 'pkgA');
    const pkgB = join(root, 'pkgB');
    write(pkgA, 'test/shared.test.ts');
    write(pkgA, 'test/live.test.ts');
    write(pkgB, 'test/shared.test.ts');
    writeHistory(
      pkgB,
      runs((i) => [
        clean(join(pkgA, 'test', 'shared.test.ts'), 'shared'),
        flaked(join(pkgA, 'test', 'live.test.ts'), 'live flake', i),
      ]),
    );
    await invokeCanary(['inventory', '--root', pkgB]);
    const { code, flakiness } = await ciReady(pkgB);
    expect(flakiness.verdict).toBe('fail');
    expect(code).toBe(1);
  });

  it('keeps a live bare stored name scored beside a scoped inventory', async () => {
    write(root, 'e2e/a.spec.ts');
    write(root, 'e2e/b.spec.ts');
    write(root, 'other/a.spec.ts');
    writeHistory(
      root,
      runs((i) => [clean('a.spec.ts', 'a'), flaked('b.spec.ts', 'b', i)]),
    );
    await invokeCanary(['inventory', 'other', '--root', root]);
    const { code, flakiness } = await ciReady(root);
    expect(flakiness.verdict).toBe('fail');
    expect(code).toBe(1);
  });

  it('F2: prints the same-title warning in text output', async () => {
    write(root, LIVE);
    write(root, 'tests/payment.spec.ts');
    writeHistory(
      root,
      runs(
        (i) =>
          i < 25
            ? [flaked('tests/pay.spec.ts', 'charges', i), clean(LIVE)]
            : [clean('tests/payment.spec.ts', 'charges'), clean(LIVE)],
        30,
      ),
    );
    await invokeCanary(['inventory', '--root', root]);
    const res = await invokeCanary(['ci-ready', '--root', root]);
    expect(res.stdout).toContain(
      'retired tests/pay.spec.ts \u{203A} charges, but the same title exists in tests/payment.spec.ts',
    );
  });
});
