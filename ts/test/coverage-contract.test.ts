/**
 * Faithful TypeScript port of `tests/unit/test_coverage_contract.py`.
 *
 * `parseCoverageJson` is lenient — it silently drops malformed files, lines,
 * and values, so a producer emitting a slightly-wrong shape gets zero feedback
 * and its coverage just vanishes into the heuristic tier. `validateCoverageJson`
 * is the loud counterpart: it reports, at two severities, exactly what the
 * parser would silently discard.
 *
 * PORT NOTE (int vs. number): `JSON.parse` collapses `3.0` → `3` (JS has no
 * int/float distinction), so a literal integer-valued float cannot be
 * distinguished from an integer once parsed. The Python cases `3.0` and `2.0`
 * are therefore replaced with genuine non-integers (`3.7`, `2.5`) here; every
 * other case (bool, numeric string, out-of-range, negative) ports verbatim.
 */

import { describe, expect, it } from 'vitest';

import {
  type CoverageProblem,
  parseCoverageJson,
  validateCoverageJson,
} from '../src/guardian/coverage.js';

function errors(data: unknown): CoverageProblem[] {
  return validateCoverageJson(data).filter((p) => p.severity === 'error');
}
function warnings(data: unknown): CoverageProblem[] {
  return validateCoverageJson(data).filter((p) => p.severity === 'warning');
}

/**
 * The resolved hit map for one path, without the per-file wrapper.
 *
 * Since #657 the index value is `{ hits, coverable }` — these tests are about
 * which hit counts survive parsing, so they assert on `hits` and leave the
 * coverable set to the tests that are actually about it.
 */
function hitsOf(data: unknown, path = 'a.py'): unknown {
  const index = parseCoverageJson(data);
  return index === null ? null : index[path]?.hits;
}

describe('valid shapes', () => {
  it('line_hits is clean', () => {
    const data = {
      files: { 'pkg/foo.py': { line_hits: { '12': 3, '14': 0 } } },
    };
    expect(validateCoverageJson(data)).toEqual([]);
  });

  it('covered_lines is a valid shape', () => {
    // Still valid, and still parses — but since #657 a covered_lines-only
    // document also carries an advisory, because it cannot distinguish an
    // unhit line from one that was never instrumented. The shape is fine; the
    // ambiguity is what the warning is about, and it is asserted below.
    const data = { files: { 'pkg/foo.py': { covered_lines: [12, 13, 15] } } };
    expect(errors(data)).toEqual([]);
  });

  it('both fields is clean', () => {
    const data = {
      files: {
        'pkg/foo.py': { line_hits: { '14': 0 }, covered_lines: [12, 13] },
      },
    };
    expect(validateCoverageJson(data)).toEqual([]);
  });

  it('schema_version 1 is clean', () => {
    // `line_hits` with an explicit zero, not the covered_lines shorthand, so
    // the subject under test is schema_version and nothing else can warn.
    const data = {
      schema_version: 1,
      files: { 'a.py': { line_hits: { '1': 1, '2': 0 } } },
    };
    expect(validateCoverageJson(data)).toEqual([]);
  });

  it('schema_version absent is clean', () => {
    const data = { files: { 'a.py': { covered_lines: [1] } } };
    expect(errors(data)).toEqual([]);
  });

  it('unknown top-level key is ignored', () => {
    const data = {
      files: { 'a.py': { line_hits: { '1': 1, '2': 0 } } },
      meta: { tool: 'x' },
    };
    expect(validateCoverageJson(data)).toEqual([]);
  });
});

describe('errors', () => {
  it('top level not object', () => {
    expect(errors([1, 2, 3]).length).toBe(1);
  });

  it('files missing', () => {
    expect(errors({ schema_version: 1 })).not.toEqual([]);
  });

  it('files not object', () => {
    expect(errors({ files: ['a.py'] })).not.toEqual([]);
  });

  it('entry not object is error', () => {
    const data = { files: { 'pkg/foo.py': [12, 13] } };
    const errs = errors(data);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]!.location).toContain('pkg/foo.py');
  });

  it('unsupported schema_version', () => {
    const data = {
      schema_version: 2,
      files: { 'a.py': { covered_lines: [1] } },
    };
    expect(errors(data)).not.toEqual([]);
  });
});

describe('warnings', () => {
  it('line_hits non-int value', () => {
    const data = { files: { 'a.py': { line_hits: { '12': 'three' } } } };
    expect(warnings(data)).not.toEqual([]);
    expect(errors(data)).toEqual([]);
  });

  it('covered_lines non-int element', () => {
    const data = { files: { 'a.py': { covered_lines: [12, 'x', 14] } } };
    expect(warnings(data)).not.toEqual([]);
    expect(errors(data)).toEqual([]);
  });

  it('line number below one', () => {
    const data = { files: { 'a.py': { covered_lines: [0, 1] } } };
    expect(warnings(data)).not.toEqual([]);
  });

  it('entry with no coverage fields', () => {
    const data = { files: { 'a.py': {} } };
    expect(warnings(data)).not.toEqual([]);
    expect(errors(data)).toEqual([]);
  });

  it('line_hits not object', () => {
    const data = { files: { 'a.py': { line_hits: [1, 2] } } };
    expect(warnings(data)).not.toEqual([]);
  });

  it('renders JSON scalars Python-style in messages (True/False/None)', () => {
    // FIX 3: `{v!r}` spelling — a bool/null value must read True/False/None, not
    // the JS true/false/null, so the warning is byte-for-byte the oracle's.
    const boolMsg = warnings({
      files: { 'a.py': { line_hits: { '1': true } } },
    })[0]!.message;
    expect(boolMsg).toContain('True');
    const nullMsg = warnings({
      files: { 'a.py': { covered_lines: [null] } },
    })[0]!.message;
    expect(nullMsg).toContain('None');
  });
});

describe('parser binding', () => {
  it('error docs are unusable by parser', () => {
    expect(parseCoverageJson([1, 2, 3])).toBeNull();
    expect(parseCoverageJson({ files: ['a.py'] })).toBeNull();
  });

  it('warning-only docs still parse', () => {
    const data = { files: { 'a.py': { line_hits: { '12': 'bad', '13': 2 } } } };
    expect(errors(data)).toEqual([]);
    const index = parseCoverageJson(data);
    expect(index).not.toBeNull();
    expect(index!['a.py']!.hits).toEqual({ 13: 2 });
  });

  it('non-integer values rejected by both', () => {
    // bool/float/numeric-string: none is a JSON integer per the contract. `3.0`
    // is unrepresentable in JS (collapses to 3), so only genuine non-integers
    // are exercised for the float case.
    for (const bad of [true, '3', 3.7]) {
      const data = { files: { 'a.py': { line_hits: { '12': bad } } } };
      expect(warnings(data), String(bad)).not.toEqual([]);
      expect(errors(data), String(bad)).toEqual([]);
      expect(hitsOf(data), String(bad)).toEqual({});
    }
  });

  it('non-integer covered line rejected by both', () => {
    for (const bad of [false, '5', 2.5]) {
      const data = { files: { 'a.py': { covered_lines: [bad] } } };
      expect(warnings(data), String(bad)).not.toEqual([]);
      expect(hitsOf(data), String(bad)).toEqual({});
    }
  });

  it('clean doc parses to expected index', () => {
    const data = {
      files: { 'a.py': { line_hits: { '14': 0 }, covered_lines: [12] } },
    };
    expect(validateCoverageJson(data)).toEqual([]);
    expect(hitsOf(data)).toEqual({ 12: 1, 14: 0 });
  });

  it('unsupported schema_version is dropped by parser', () => {
    const data = {
      schema_version: 2,
      files: { 'a.py': { line_hits: { '1': 3 } } },
    };
    expect(errors(data)).not.toEqual([]);
    expect(parseCoverageJson(data)).toBeNull();
  });

  it('line_hits wins over contradicting covered line', () => {
    const data = {
      files: { 'a.py': { line_hits: { '14': 0 }, covered_lines: [14] } },
    };
    expect(errors(data)).toEqual([]);
    expect(warnings(data)).not.toEqual([]);
    expect(hitsOf(data)).toEqual({ 14: 0 });
  });

  it('out of range are dropped not kept', () => {
    const entries = [
      { line_hits: { '-3': 5 } },
      { line_hits: { '5': -3 } },
      { covered_lines: [0] },
    ];
    for (const entry of entries) {
      const data = { files: { 'a.py': entry } };
      expect(warnings(data), JSON.stringify(entry)).not.toEqual([]);
      expect(hitsOf(data), JSON.stringify(entry)).toEqual({});
    }
  });

  it('empty containers warn like missing', () => {
    const entries = [{}, { line_hits: {} }, { covered_lines: [] }];
    for (const entry of entries) {
      const data = { files: { 'a.py': entry } };
      expect(warnings(data), JSON.stringify(entry)).not.toEqual([]);
      expect(errors(data), JSON.stringify(entry)).toEqual([]);
    }
  });
});

/**
 * The validator is the producer-facing half of `instrumented_lines` (#657).
 *
 * The field only helps if a producer learns it exists. The document that most
 * needs it — `covered_lines` alone, the shape a naive lcov transcode produces —
 * is silently ambiguous: every line it omits is reported as a coverage gap, and
 * the producer sees nothing. Saying so is the whole point.
 */
describe('instrumented_lines (#657)', () => {
  const file = (entry: Record<string, unknown>): unknown => ({
    files: { 'a.py': entry },
  });

  /** Location and message together — a shape complaint names its field. */
  function messages(data: unknown): string {
    return validateCoverageJson(data)
      .map((p) => `${p.location} ${p.message}`)
      .join('\n');
  }

  it('warns that a covered_lines-only document cannot express a miss', () => {
    // The #657 trap exactly: this is what transcoding lcov produces, and every
    // non-instrumented line it dropped becomes a reported gap downstream.
    const problems = warnings(file({ covered_lines: [10, 11] }));

    expect(problems).not.toEqual([]);
    expect(messages(file({ covered_lines: [10, 11] }))).toMatch(
      /instrumented_lines/,
    );
  });

  it('stays quiet once the producer declares what it instrumented', () => {
    // Declaring the set resolves the ambiguity, so the warning must clear —
    // otherwise it is noise a producer learns to ignore.
    expect(
      warnings(file({ covered_lines: [10], instrumented_lines: [10, 11] })),
    ).toEqual([]);
  });

  it('stays quiet when line_hits carries an explicit zero', () => {
    // The other documented way to report a miss. A producer already doing the
    // right thing must not be nagged toward a second mechanism.
    expect(warnings(file({ line_hits: { '10': 1, '11': 0 } }))).toEqual([]);
  });

  it('warns on a declared line that line_hits contradicts', () => {
    // 50 has a hit count but was never declared instrumented. The parser
    // resolves it (measurement wins); the producer should still hear about it.
    expect(
      warnings(file({ line_hits: { '50': 0 }, instrumented_lines: [10] })),
    ).not.toEqual([]);
  });

  it('warns and ignores a malformed declaration', () => {
    for (const bad of ['all', 42, { a: 1 }]) {
      const data = file({ line_hits: { '10': 1 }, instrumented_lines: bad });
      expect(warnings(data), JSON.stringify(bad)).not.toEqual([]);
      expect(errors(data), JSON.stringify(bad)).toEqual([]);
    }
  });

  it('warns on a non-integer or out-of-range declared line', () => {
    // `line_hits` is present so the entry is otherwise clean — without it the
    // "no coverage data at all" warning would fire and this would pass whether
    // or not the declared lines were checked.
    for (const bad of ['3', 3.5, 0, -1, true]) {
      const data = file({
        line_hits: { '10': 1 },
        instrumented_lines: [10, bad],
      });
      expect(messages(data), JSON.stringify(bad)).toMatch(/instrumented_lines/);
    }
  });
});
