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
  const at = (src: string[], measured: number[], added: number[]) =>
    Object.fromEntries(
      attributeLines(added, new Set(measured), src.join('\n')) ?? [],
    );

  it('a type alias inside a block is not a continuation of the block opener', () => {
    const src = ['if (a) {', '  type T = string;', '  run();', '}'];
    expect(at(src, [1, 3], [2])).toEqual({});
  });

  it('a line after a closed block is not a continuation', () => {
    const src = [
      'function f() {',
      '  done();',
      '}',
      'interface X {',
      '  a: string;',
      '}',
    ];
    expect(at(src, [2], [4, 5])).toEqual({});
  });

  it('an unbalanced snippet (lexer lost) fails closed: every code line scored', () => {
    const src = ['  done();', '}', 'interface X {', '  a: string;', '}'];
    expect(at(src, [1], [3, 4])).toEqual({ 3: 1, 4: 1 });
  });

  it('a regex literal with brackets does not throw the lexer off', () => {
    const src = ['const re = /[})\\];,]+/;', 'type T = 1;'];
    expect(at(src, [1], [2])).toEqual({});
  });

  it('a line that closes a callback and continues the chain is scored', () => {
    const src = ['run(() => {', '  go();', '}).catch(log);'];
    expect(at(src, [1, 2], [3])).toEqual({ 3: 1 });
  });

  it('a multi-line template literal carries its quote across lines', () => {
    const src = ['const s = `a {', '  b ${x} }', '  c`;', 'type T = 1;'];
    expect(at(src, [1], [2, 3, 4])).toEqual({ 2: 1, 3: 1 });
  });

  it('an unrecognised comment form (Python #) inside a call fails closed', () => {
    const src = ['x = call(', '    # why', '    arg,', ')'];
    expect(at(src, [1], [2, 3])).toEqual({ 2: 1, 3: 1 });
  });

  it('a chain link after a multi-line callback continues the outer statement', () => {
    const src = [
      'return items',
      '  .map((r) => {',
      '    return r.x;',
      '  })',
      '  .filter(Boolean);',
    ];
    // The `})` closer joins the outer statement too (closed direction).
    expect(at(src, [1, 3], [4, 5])).toEqual({ 4: 1, 5: 1 });
  });

  it('a recorded line inside call arguments does not own the link after the call', () => {
    const src = ['foo(', '  a(),', ')', '  .b();'];
    expect(at(src, [1, 2], [4])).toEqual({ 4: 1 });
  });

  it('cannot judge (null) with no source, so the caller fails closed', () => {
    expect(attributeLines([1, 2], new Set([1]), null)).toBeNull();
  });

  it('cannot judge a source shorter than the diff (source/diff mismatch)', () => {
    expect(attributeLines([1, 9], new Set([1]), 'a();\nb();')).toBeNull();
  });

  it('cannot judge a source over the scan cap', () => {
    const huge = 'x();\n'.repeat(600_000);
    expect(attributeLines([2], new Set([1]), huge)).toBeNull();
  });

  it('a statement longer than any fixed look-back window is still attributed', () => {
    const args = Array.from({ length: 500 }, (_, i) => `  a${i},`);
    const src = ['call(', ...args, ')', '  .then(done);'];
    expect(at(src, [1], [503])).toEqual({ 503: 1 });
  });

  it('stays linear on adversarial input (nested open blocks, long lines)', () => {
    const long = 'v'.repeat(1000);
    const src = Array.from({ length: 600 }, (_, i) =>
      i % 2 === 0 ? `if (a) { ${long}` : '  type T = 1;',
    );
    const measured = src.map((_, i) => i + 1).filter((n) => n % 2 === 1);
    const added = src.map((_, i) => i + 1);
    const t = performance.now();
    attributeLines(added, new Set(measured), src.join('\n'));
    expect(performance.now() - t).toBeLessThan(1000);
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
});

describe('#1314 fail closed: what cannot be judged is never "non-executable"', () => {
  it('an edit to an unhit statement, flagged before #1314, is still a finding', () => {
    const { results, coverage } = resolve([[3, 5]], [3]);
    expect(coverage.unitsNonCoverable).toBe(0);
    expect(results[0]!.fidelity).toBe(Fidelity.CoverageVerified);
    expect(results[0]!.covered).toBe(false);
    expect(results[0]!.uncovered_lines).toEqual([3, 4, 5]);
  });

  it('an unreadable source scores every changed line (a finding, not ✅)', () => {
    const unit: ChangedUnit = { path: 'src/gone.ts', added_ranges: [[4, 4]] };
    const report = join(tmp, 'gone.info');
    writeFileSync(report, 'SF:src/gone.ts\nDA:3,1\nend_of_record\n');
    const { results, coverage } = resolveCoverageWithInput([unit], {
      coveragePath: report,
      graphPath: join(tmp, 'missing-graph.json'),
      repoRoot: tmp,
    });
    expect(coverage.unitsNonCoverable).toBe(0);
    expect(results[0]!.covered).toBe(false);
    expect(results[0]!.uncovered_lines).toEqual([4]);
  });

  it('a source that does not match the diff (too short) fails closed too', () => {
    const { results, coverage } = resolve([[40, 40]]);
    expect(coverage.unitsNonCoverable).toBe(0);
    expect(results[0]!.covered).toBe(false);
  });
});
