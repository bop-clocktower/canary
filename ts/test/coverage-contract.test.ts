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

describe('valid shapes', () => {
  it('line_hits is clean', () => {
    const data = {
      files: { 'pkg/foo.py': { line_hits: { '12': 3, '14': 0 } } },
    };
    expect(validateCoverageJson(data)).toEqual([]);
  });

  it('covered_lines is clean', () => {
    const data = { files: { 'pkg/foo.py': { covered_lines: [12, 13, 15] } } };
    expect(validateCoverageJson(data)).toEqual([]);
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
    const data = {
      schema_version: 1,
      files: { 'a.py': { covered_lines: [1] } },
    };
    expect(validateCoverageJson(data)).toEqual([]);
  });

  it('schema_version absent is clean', () => {
    const data = { files: { 'a.py': { covered_lines: [1] } } };
    expect(errors(data)).toEqual([]);
  });

  it('unknown top-level key is ignored', () => {
    const data = {
      files: { 'a.py': { covered_lines: [1] } },
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
    expect(index!['a.py']).toEqual({ 13: 2 });
  });

  it('non-integer values rejected by both', () => {
    // bool/float/numeric-string: none is a JSON integer per the contract. `3.0`
    // is unrepresentable in JS (collapses to 3), so only genuine non-integers
    // are exercised for the float case.
    for (const bad of [true, '3', 3.7]) {
      const data = { files: { 'a.py': { line_hits: { '12': bad } } } };
      expect(warnings(data), String(bad)).not.toEqual([]);
      expect(errors(data), String(bad)).toEqual([]);
      expect(parseCoverageJson(data), String(bad)).toEqual({ 'a.py': {} });
    }
  });

  it('non-integer covered line rejected by both', () => {
    for (const bad of [false, '5', 2.5]) {
      const data = { files: { 'a.py': { covered_lines: [bad] } } };
      expect(warnings(data), String(bad)).not.toEqual([]);
      expect(parseCoverageJson(data), String(bad)).toEqual({ 'a.py': {} });
    }
  });

  it('clean doc parses to expected index', () => {
    const data = {
      files: { 'a.py': { line_hits: { '14': 0 }, covered_lines: [12] } },
    };
    expect(validateCoverageJson(data)).toEqual([]);
    expect(parseCoverageJson(data)).toEqual({ 'a.py': { 12: 1, 14: 0 } });
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
    expect(parseCoverageJson(data)).toEqual({ 'a.py': { 14: 0 } });
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
      expect(parseCoverageJson(data), JSON.stringify(entry)).toEqual({
        'a.py': {},
      });
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
