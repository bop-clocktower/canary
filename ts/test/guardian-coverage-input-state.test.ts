/**
 * #554 — the coverage ladder must RECORD which mode it ran in.
 *
 * `resolveCoverage` silently falls through report → graph → heuristic, and five
 * very different inputs (no report, missing file, unparseable file, a report
 * that matched none of the changed files, a report that matched some) all
 * produce the same clean-looking result. These tests pin the observable
 * distinction: a {@link CoverageInputState} per run, plus the notice a reader
 * sees.
 *
 * Zero files matched is an abstention, not a pass.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ChangedUnit,
  coverageDegradedNotice,
  coverageStatus,
  resolveCoverageWithInput,
} from '../src/guardian/coverage.js';
import { mkTmp, rmTmp } from './guardian-cli-testkit.js';

let tmp: string;
beforeEach(() => {
  tmp = mkTmp();
});
afterEach(() => rmTmp(tmp));

/** Two changed units; `pkg/a.ts` is the one the fixtures report on. */
function units(): ChangedUnit[] {
  return [
    { path: 'pkg/a.ts', added_ranges: [[1, 2]] },
    { path: 'pkg/b.ts', added_ranges: [[1, 2]] },
  ];
}

/** Write an lcov reporting on `paths`, every added line hit. */
function writeLcov(paths: string[]): string {
  const body = paths
    .map((p) => `SF:${p}\nDA:1,1\nDA:2,1\nend_of_record\n`)
    .join('');
  const path = join(tmp, 'lcov.info');
  writeFileSync(path, body, 'utf-8');
  return path;
}

/** An empty repo root so the heuristic tier finds no test files. */
function emptyRoot(): string {
  const root = join(tmp, 'repo');
  mkdirSync(root, { recursive: true });
  return root;
}

describe('CoverageInputState records the run mode (#554)', () => {
  it('no report supplied: unavailable, nothing found or parsed', () => {
    const { coverage } = resolveCoverageWithInput(units(), {
      coveragePath: null,
      graphPath: join(tmp, 'missing-graph.json'),
      repoRoot: emptyRoot(),
    });
    expect(coverage.requested).toBeNull();
    expect(coverage.found).toBe(false);
    expect(coverage.parsed).toBe(false);
    expect(coverage.filesInReport).toBe(0);
    expect(coverage.unitsMatched).toBe(0);
    expect(coverage.unitsTotal).toBe(2);
    expect(coverageStatus(coverage)).toBe('unavailable');
  });

  it('report path supplied but the file is absent: found=false', () => {
    const missing = join(tmp, 'nope-lcov.info');
    const { coverage } = resolveCoverageWithInput(units(), {
      coveragePath: missing,
      graphPath: join(tmp, 'missing-graph.json'),
      repoRoot: emptyRoot(),
    });
    expect(coverage.requested).toBe(missing);
    expect(coverage.found).toBe(false);
    expect(coverage.parsed).toBe(false);
    expect(coverageStatus(coverage)).toBe('unavailable');
  });

  it('report present but yields no records: found=true, parsed=false', () => {
    const path = join(tmp, 'lcov.info');
    writeFileSync(path, 'this is not an lcov file\n', 'utf-8');
    const { coverage } = resolveCoverageWithInput(units(), {
      coveragePath: path,
      graphPath: join(tmp, 'missing-graph.json'),
      repoRoot: emptyRoot(),
    });
    expect(coverage.found).toBe(true);
    expect(coverage.parsed).toBe(false);
    expect(coverage.filesInReport).toBe(0);
    expect(coverageStatus(coverage)).toBe('unavailable');
  });

  it('report parses but matches none of the changed files', () => {
    const path = writeLcov(['other/unrelated.ts']);
    const { coverage } = resolveCoverageWithInput(units(), {
      coveragePath: path,
      graphPath: join(tmp, 'missing-graph.json'),
      repoRoot: emptyRoot(),
    });
    expect(coverage.found).toBe(true);
    expect(coverage.parsed).toBe(true);
    expect(coverage.filesInReport).toBe(1);
    expect(coverage.unitsMatched).toBe(0);
    // The critical case: a parsed report is NOT evidence the diff was covered.
    expect(coverageStatus(coverage)).toBe('unavailable');
  });

  it('report matches some changed files: partial', () => {
    const path = writeLcov(['pkg/a.ts']);
    const { coverage, results } = resolveCoverageWithInput(units(), {
      coveragePath: path,
      graphPath: join(tmp, 'missing-graph.json'),
      repoRoot: emptyRoot(),
    });
    expect(coverage.unitsMatched).toBe(1);
    expect(coverage.unitsTotal).toBe(2);
    expect(coverageStatus(coverage)).toBe('partial');
    // The ladder still resolves every unit, in input order (unchanged contract).
    expect(results).toHaveLength(2);
    expect(results[0]!.fidelity).toBe('coverage-verified');
    expect(results[1]!.fidelity).toBe('heuristic');
  });

  it('report matches every changed file: verified, no notice', () => {
    const path = writeLcov(['pkg/a.ts', 'pkg/b.ts']);
    const { coverage } = resolveCoverageWithInput(units(), {
      coveragePath: path,
      graphPath: join(tmp, 'missing-graph.json'),
      repoRoot: emptyRoot(),
    });
    expect(coverage.unitsMatched).toBe(2);
    expect(coverageStatus(coverage)).toBe('verified');
    expect(coverageDegradedNotice(coverage)).toBeNull();
  });
});

describe('coverageDegradedNotice states the actual input state (#554)', () => {
  const state = (over: Partial<Parameters<typeof coverageStatus>[0]> = {}) => ({
    requested: null,
    found: false,
    parsed: false,
    filesInReport: 0,
    unitsMatched: 0,
    unitsTotal: 2,
    ...over,
  });

  it('no report: says so and names the fallback tier', () => {
    const notice = coverageDegradedNotice(state())!;
    expect(notice).toContain('coverage unavailable');
    expect(notice).toContain('no coverage report');
    expect(notice).toMatch(/graph\/heuristic/);
  });

  it('missing file: names the path it looked for', () => {
    const notice = coverageDegradedNotice(
      state({ requested: '/x/lcov.info' }),
    )!;
    expect(notice).toContain('coverage unavailable');
    expect(notice).toContain('/x/lcov.info');
    expect(notice).toContain('not found');
  });

  it('unparseable file: distinguishes "found" from "usable"', () => {
    const notice = coverageDegradedNotice(
      state({ requested: '/x/lcov.info', found: true }),
    )!;
    expect(notice).toContain('/x/lcov.info');
    expect(notice).toMatch(/no usable records/);
  });

  it('parsed but zero matched: reports both denominators', () => {
    const notice = coverageDegradedNotice(
      state({
        requested: '/x/lcov.info',
        found: true,
        parsed: true,
        filesInReport: 7,
      }),
    )!;
    expect(notice).toContain('coverage unavailable');
    expect(notice).toContain('7');
    expect(notice).toContain('0 of 2');
  });

  it('partial: reports matched-of-total and the fallback for the rest', () => {
    const notice = coverageDegradedNotice(
      state({
        requested: '/x/lcov.info',
        found: true,
        parsed: true,
        filesInReport: 7,
        unitsMatched: 1,
      }),
    )!;
    expect(notice).toContain('coverage partial');
    expect(notice).toContain('1 of 2');
  });

  it('nothing judged (unitsTotal 0): no claim either way', () => {
    expect(coverageDegradedNotice(state({ unitsTotal: 0 }))).toBeNull();
  });
});

/**
 * #883 (a) — "matched 0" has two causes that call for opposite fixes: the
 * changed files lie outside every tree the report instruments (a scope gap —
 * no fresh report would ever match), or they lie inside one and the report is
 * stale. The state must carry the ELIGIBLE denominator and the notice must say
 * which case this is.
 */
describe('zero-match abstention names its cause (#883)', () => {
  it('changed files outside every instrumented tree: scope gap, 0 eligible', () => {
    const path = writeLcov(['other/unrelated.ts']);
    const { coverage } = resolveCoverageWithInput(units(), {
      coveragePath: path,
      graphPath: join(tmp, 'missing-graph.json'),
      repoRoot: emptyRoot(),
    });
    expect(coverage.unitsEligible).toBe(0);
    const notice = coverageDegradedNotice(coverage)!;
    expect(notice).toContain('coverage unavailable');
    expect(notice).toContain('0 of 2 changed file(s)');
    expect(notice).toContain('outside every tree');
    expect(notice).toContain('instrumentation-scope gap');
    expect(notice).not.toContain('stale');
  });

  it('changed files inside an instrumented tree but unmatched: likely stale', () => {
    const path = writeLcov(['pkg/c.ts']);
    const { coverage } = resolveCoverageWithInput(units(), {
      coveragePath: path,
      graphPath: join(tmp, 'missing-graph.json'),
      repoRoot: emptyRoot(),
    });
    expect(coverage.unitsEligible).toBe(2);
    const notice = coverageDegradedNotice(coverage)!;
    expect(notice).toContain('2 of 2 changed file(s)');
    expect(notice).toContain('stale');
    expect(notice).not.toContain('instrumentation-scope gap');
  });

  it('anchors report-relative paths so npm/src is not mistaken for ts/src', () => {
    // The canary shape: report at ts/coverage/lcov.info, SF paths rooted at ts/.
    const root = emptyRoot();
    mkdirSync(join(root, 'ts', 'src'), { recursive: true });
    mkdirSync(join(root, 'ts', 'coverage'), { recursive: true });
    writeFileSync(join(root, 'ts', 'src', 'cli.ts'), '', 'utf-8');
    const report = join(root, 'ts', 'coverage', 'lcov.info');
    writeFileSync(report, 'SF:src/cli.ts\nDA:1,1\nend_of_record\n', 'utf-8');
    const changed: ChangedUnit[] = [
      { path: 'npm/src/overlays-registry.ts', added_ranges: [[1, 2]] },
      { path: 'ts/src/brand-new.ts', added_ranges: [[1, 2]] },
    ];
    const { coverage } = resolveCoverageWithInput(changed, {
      coveragePath: report,
      graphPath: join(tmp, 'missing-graph.json'),
      repoRoot: root,
    });
    expect(coverage.unitsMatched).toBe(0);
    expect(coverage.unitsEligible).toBe(1);
  });

  it('narrows divergent report directories to their shared parent tree', () => {
    // src/a and src/b diverge, so the instrumented tree is src/, not src/a/:
    // a sibling src/c file is eligible, a file outside src/ is not.
    const path = writeLcov(['src/a/x.ts', 'src/b/y.ts']);
    const changed: ChangedUnit[] = [
      { path: 'src/c/z.ts', added_ranges: [[1, 2]] },
      { path: 'lib/z.ts', added_ranges: [[1, 2]] },
    ];
    const { coverage } = resolveCoverageWithInput(changed, {
      coveragePath: path,
      graphPath: join(tmp, 'missing-graph.json'),
      repoRoot: emptyRoot(),
    });
    expect(coverage.unitsMatched).toBe(0);
    expect(coverage.unitsEligible).toBe(1);
  });

  it('anchors from any surviving sample when the first report path was deleted', () => {
    // A stale report is exactly the case (a) must name: its first SF path may no
    // longer exist, and anchoring on that one sample alone would drop the ts/
    // prefix and misreport ts/src changes as an instrumentation-scope gap.
    const root = emptyRoot();
    mkdirSync(join(root, 'ts', 'src'), { recursive: true });
    mkdirSync(join(root, 'ts', 'coverage'), { recursive: true });
    writeFileSync(join(root, 'ts', 'src', 'cli.ts'), '', 'utf-8');
    const report = join(root, 'ts', 'coverage', 'lcov.info');
    writeFileSync(
      report,
      'SF:src/deleted.ts\nDA:1,1\nend_of_record\n' +
        'SF:src/cli.ts\nDA:1,1\nend_of_record\n',
      'utf-8',
    );
    const changed: ChangedUnit[] = [
      { path: 'ts/src/brand-new.ts', added_ranges: [[1, 2]] },
    ];
    const { coverage } = resolveCoverageWithInput(changed, {
      coveragePath: report,
      graphPath: join(tmp, 'missing-graph.json'),
      repoRoot: root,
    });
    expect(coverage.unitsEligible).toBe(1);
    expect(coverageDegradedNotice(coverage)).toContain('stale');
  });
});
