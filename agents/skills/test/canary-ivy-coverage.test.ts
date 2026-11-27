/**
 * canary-ivy (#615) -- overlapping coverage (spec D2, D3, D4, SC7). Coverage
 * files are synthetic.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CAVEAT,
  groupOverlaps,
  loadCoverage,
  ranges,
} from '../claude-code/canary-ivy/scripts/coverage.mjs';

const tmps: string[] = [];
function write(value: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-ivy-cov-'));
  tmps.push(dir);
  const file = path.join(dir, 'cov.json');
  fs.writeFileSync(
    file,
    typeof value === 'string' ? value : JSON.stringify(value),
  );
  return file;
}

afterEach(() => {
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
});

const neutral = {
  schema_version: 1,
  tests: {
    'tests/test_cart.py::test_total_sums_items': {
      'src/cart.py': [3, 4, 5, 9],
      'src/money.py': [1],
    },
    'tests/test_cart.py::test_total_rounds_to_cents': {
      'src/money.py': [1],
      'src/cart.py': [9, 5, 4, 3],
    },
    'tests/test_cart.py::test_empty_cart': { 'src/cart.py': [3, 4] },
    'tests/test_cart.py::test_never_ran': { 'src/cart.py': [] },
  },
};

const coveragePy = {
  meta: { version: '7.6.0', show_contexts: true },
  files: {
    'src/cart.py': {
      executed_lines: [3, 4, 5, 9],
      contexts: {
        '3': [
          '',
          'tests/test_cart.py::test_total_sums_items|run',
          'tests/test_cart.py::test_total_rounds_to_cents|run',
          'tests/test_cart.py::test_empty_cart|run',
        ],
        '4': [
          'tests/test_cart.py::test_total_sums_items|run',
          'tests/test_cart.py::test_total_rounds_to_cents|setup',
          'tests/test_cart.py::test_empty_cart|run',
        ],
        '5': [
          'tests/test_cart.py::test_total_sums_items|run',
          'tests/test_cart.py::test_total_rounds_to_cents|run',
        ],
        '9': [
          'tests/test_cart.py::test_total_sums_items|run',
          'tests/test_cart.py::test_total_rounds_to_cents|run',
        ],
      },
    },
    'src/money.py': {
      contexts: {
        '1': [
          'tests/test_cart.py::test_total_sums_items|run',
          'tests/test_cart.py::test_total_rounds_to_cents|run',
        ],
      },
    },
  },
};

describe('ranges', () => {
  it('compresses sorted line numbers into ranges', () => {
    expect(ranges([9, 3, 4, 5, 10, 12])).toBe('3-5,9-10,12');
    expect(ranges([7])).toBe('7');
  });
});

describe('loadCoverage + groupOverlaps', () => {
  it('groups tests whose covered lines are identical and names the lines', () => {
    const { tests } = loadCoverage(write(neutral));
    const result = groupOverlaps(tests);
    expect(result.testsWithCoverage).toBe(3);
    expect(result.groups).toEqual([
      {
        tests: [
          'tests/test_cart.py::test_total_rounds_to_cents',
          'tests/test_cart.py::test_total_sums_items',
        ],
        line_count: 5,
        shared_lines: [
          { file: 'src/cart.py', ranges: '3-5,9' },
          { file: 'src/money.py', ranges: '1' },
        ],
        caveat: CAVEAT,
      },
    ]);
  });

  it('reads coverage.py --show-contexts JSON to the same groups', () => {
    const fromPy = groupOverlaps(loadCoverage(write(coveragePy)).tests);
    const fromNeutral = groupOverlaps(loadCoverage(write(neutral)).tests);
    expect(fromPy).toEqual(fromNeutral);
  });

  it('does not group tests whose lines differ by one', () => {
    const data = {
      schema_version: 1,
      tests: { a: { 'x.py': [1, 2] }, b: { 'x.py': [1, 2, 3] } },
    };
    expect(groupOverlaps(loadCoverage(write(data)).tests).groups).toEqual([]);
  });

  it('orders larger groups first', () => {
    const data = {
      schema_version: 1,
      tests: {
        a: { 'x.py': [1] },
        b: { 'x.py': [1] },
        c: { 'y.py': [2] },
        d: { 'y.py': [2] },
        e: { 'y.py': [2] },
      },
    };
    const groups = groupOverlaps(loadCoverage(write(data)).tests).groups;
    expect(groups.map((g: { tests: string[] }) => g.tests)).toEqual([
      ['c', 'd', 'e'],
      ['a', 'b'],
    ]);
  });

  it('says why when coverage.py JSON carries no contexts', () => {
    const { tests, note } = loadCoverage(
      write({ meta: {}, files: { 'a.py': { executed_lines: [1] } } }),
    );
    expect(tests.size).toBe(0);
    expect(note).toContain('--show-contexts');
  });
});

describe('loadCoverage errors', () => {
  it('rejects a missing file', () => {
    expect(() => loadCoverage('/no/such/ivy-cov.json')).toThrow(
      'coverage file not found: /no/such/ivy-cov.json',
    );
  });

  it('rejects unparseable JSON', () => {
    expect(() => loadCoverage(write('{nope'))).toThrow(/malformed coverage/);
  });

  it('rejects an unknown shape', () => {
    expect(() => loadCoverage(write([1, 2]))).toThrow(
      /unrecognized coverage format/,
    );
    expect(() => loadCoverage(write({ schema_version: 2, tests: {} }))).toThrow(
      /unrecognized coverage format/,
    );
  });

  it('rejects line lists that are not positive integers', () => {
    const bad = { schema_version: 1, tests: { a: { 'x.py': [0] } } };
    expect(() => loadCoverage(write(bad))).toThrow(/positive integers/);
    const notList = { schema_version: 1, tests: { a: { 'x.py': 'all' } } };
    expect(() => loadCoverage(write(notList))).toThrow(/positive integers/);
    const notMap = { schema_version: 1, tests: { a: [] } };
    expect(() => loadCoverage(write(notMap))).toThrow(/positive integers/);
  });
});
