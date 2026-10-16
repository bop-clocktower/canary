/**
 * #1314 — an executable edit inside a multi-line expression is not a
 * "non-executable line".
 *
 * v8/istanbul lcov records a multi-line statement on ONE line (verified with
 * @vitest/coverage-v8: a ternary's arms, the terms of a multi-line `+` chain
 * and the links of a method chain get no `DA:` record of their own). The report
 * tier read "absent from the measured set" as "not executable", so guardian
 * headlined such diffs "✅ nothing to test: only non-executable lines changed"
 * on PRs #1274 and #1277 — a false green on a required check.
 *
 * The shapes below are minimal syntheses of those two diffs (and of the #841
 * object-literal shape that #928 pinned the same way); no real diff is copied.
 * `MEASURED` is what v8 emits for this source: one line per statement.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ChangedUnit,
  Fidelity,
  resolveCoverageWithInput,
} from '../src/guardian/coverage.js';
import { attributeLines } from '../src/guardian/diff-coverage/lexical/continuation.js';
import { renderFindings } from '../src/guardian/pr-check.js';
import { mkTmp, rmTmp } from './guardian-cli-testkit.js';

const SOURCE = [
  '// Budget rendering, synthesized from the #1274 shape.', // 1
  'export function render(meta: Meta | null, a: string, b: string): number {', // 2
  '  const line = meta?.p', // 3
  '    ? `<sub>${meta.p}</sub>`', // 4
  "    : '';", // 5
  '', // 6
  '  const reserve =', // 7
  '    a.length +', // 8
  '    line.length +', // 9
  '    2 +', // 10
  '    b.length;', // 11
  '  return reserve;', // 12
  '}', // 13
  '', // 14
  'type Meta = { p?: string };', // 15
  '', // 16
  'export function build(): Cmd {', // 17
  '  return new Cmd()', // 18
  "    .option('--a', 'first')", // 19
  '    .addOption(', // 20
  "      new Option('-f, --framework <framework>', 'Force framework.').choices([", // 21
  "        'x',", // 22
  '      ]),', // 23
  '    )', // 24
  "    .option('--z');", // 25
  '}', // 26
  '', // 27
  'export function payload(r: Report): object {', // 28
  '  return {', // 29
  '    kept: r.kept,', // 30
  '    // a comment inside the literal', // 31
  '    added: r.added,', // 32
  '  };', // 33
  '}', // 34
].join('\n');

const PATH = 'src/shape.ts';
const MEASURED = [3, 8, 12, 18, 29];

let tmp: string;
beforeEach(() => {
  tmp = mkTmp();
  mkdirSync(join(tmp, 'src'), { recursive: true });
  writeFileSync(join(tmp, PATH), SOURCE, 'utf-8');
});
afterEach(() => rmTmp(tmp));

/** An lcov for {@link PATH} measuring {@link MEASURED}, hit unless listed in `unhit`. */
function lcov(unhit: number[] = []): string {
  const da = MEASURED.map((l) => `DA:${l},${unhit.includes(l) ? 0 : 1}`);
  const path = join(tmp, 'lcov.info');
  writeFileSync(path, `SF:${PATH}\n${da.join('\n')}\nend_of_record\n`);
  return path;
}

function resolve(ranges: Array<[number, number]>, unhit: number[] = []) {
  const unit: ChangedUnit = { path: PATH, added_ranges: ranges };
  return resolveCoverageWithInput([unit], {
    coveragePath: lcov(unhit),
    graphPath: join(tmp, 'missing-graph.json'),
    repoRoot: tmp,
  });
}

describe('#1314: continuation lines of a multi-line statement are coverable', () => {
  it.each([
    ['a ternary arm (#1274)', [5, 5]],
    ['an arithmetic term in a multi-line initializer (#1274)', [10, 10]],
    ['the head line of a multi-line initializer', [7, 7]],
    ['a link in a method chain (#1277)', [20, 24]],
    ['a property inside a multi-line object literal (#841)', [31, 32]],
  ] as const)('%s gets a coverage-verified verdict', (_, range) => {
    const { results, coverage } = resolve([[range[0], range[1]]]);
    expect(coverage.unitsNonCoverable).toBe(0);
    expect(coverage.unitsMatched).toBe(1);
    expect(results[0]!.fidelity).toBe(Fidelity.CoverageVerified);
    expect(results[0]!.covered).toBe(true);
  });

  it('an unhit statement makes its edited continuation lines a finding', () => {
    const { results } = resolve([[20, 24]], [18]);
    expect(results[0]!.fidelity).toBe(Fidelity.CoverageVerified);
    expect(results[0]!.covered).toBe(false);
    expect(results[0]!.uncovered_lines).toEqual([20, 21, 22, 23, 24]);
  });

  it('never headlines a ternary-arm edit "only non-executable lines changed"', () => {
    const { coverage } = resolve([[5, 5]]);
    const body = renderFindings([], 'comment', 0, null, {
      checked: coverage.unitsTotal,
      abstained: false,
      coverage,
    });
    expect(body).not.toContain('non-executable');
  });
});

describe('attributeLines: the lexical continuation judgement', () => {
  const at = (
    src: string[],
    measured: number[],
    added: number[],
    path = 'a.ts',
  ) =>
    Object.fromEntries(
      attributeLines(added, new Set(measured), src.join('\n'), path),
    );

  it('a type alias inside a block is not a continuation of the block opener', () => {
    const src = ['if (a) {', '  type T = string;', '  run();', '}'];
    expect(at(src, [1, 3], [2])).toEqual({});
  });

  it('a line after a closed block is not a continuation', () => {
    const src = ['  done();', '}', 'interface X {', '  a: string;', '}'];
    expect(at(src, [1], [3, 4])).toEqual({});
  });

  it('a multi-line template literal carries its quote across lines', () => {
    const src = ['const s = `a {', '  b ${x} }', '  c`;', 'type T = 1;'];
    expect(at(src, [1], [2, 3, 4])).toEqual({ 2: 1, 3: 1 });
  });

  it('a Python whole-line # comment inside a call is never scored', () => {
    const src = ['x = call(', '    # why', '    arg,', ')'];
    expect(at(src, [1], [2, 3], 'm.py')).toEqual({ 3: 1 });
  });

  it('with no source, only measured lines are scored', () => {
    expect(
      Object.fromEntries(attributeLines([1, 2], new Set([1]), null, 'a.ts')),
    ).toEqual({ 1: 1 });
  });
});

describe('#1314 positive controls: genuinely non-executable edits stay non-coverable', () => {
  it.each([
    ['a comment line', [1, 1]],
    ['a type alias', [15, 15]],
    ['a blank line plus a function signature', [16, 17]],
  ] as const)('%s', (_, range) => {
    const { coverage } = resolve([[range[0], range[1]]]);
    expect(coverage.unitsNonCoverable).toBe(1);
    expect(coverage.unitsMatched).toBe(0);
  });

  it('an unreadable source keeps the measured-set verdict (no guessing)', () => {
    const unit: ChangedUnit = { path: 'src/gone.ts', added_ranges: [[4, 4]] };
    const report = join(tmp, 'gone.info');
    writeFileSync(report, 'SF:src/gone.ts\nDA:3,1\nend_of_record\n');
    const { coverage } = resolveCoverageWithInput([unit], {
      coveragePath: report,
      graphPath: join(tmp, 'missing-graph.json'),
      repoRoot: tmp,
    });
    expect(coverage.unitsNonCoverable).toBe(1);
  });
});
