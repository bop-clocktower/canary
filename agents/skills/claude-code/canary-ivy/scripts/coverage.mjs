// coverage -- tests whose covered lines coincide (spec D2, D3, D4).
//
// Ivy reads per-test coverage; it never produces it. Two shapes are accepted:
//
//   - coverage.py JSON written by `coverage json --show-contexts` from a run
//     with dynamic contexts (`--cov-context=test`, or `dynamic_context =
//     test_function`). Each executed line lists the contexts (tests) that ran
//     it.
//   - a neutral map any other producer can write:
//     {"schema_version": 1, "tests": {"<test id>": {"<file>": [lines]}}}
//
// Tests are grouped only when their covered (file, line) sets are EQUAL. A
// subset relation is never reported: "A covers nothing B does not" is the
// pruning premise ADR 0039 removed. Every group carries CAVEAT.

import fs from 'node:fs';

/** Stated in every overlap finding (ADR 0039, Decision 2). */
export const CAVEAT =
  'Shared line coverage does not show that these tests check the same ' +
  'behaviour. Read their assertions; each one may be the only check of ' +
  'something the lines do not reveal.';

const isPlainObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const isLine = (n) => Number.isInteger(n) && n > 0;

function readJson(file) {
  if (!fs.existsSync(file)) throw new Error(`coverage file not found: ${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (exc) {
    throw new Error(`malformed coverage file ${file}: ${exc.message}`);
  }
}

function addLines(tests, test, file, lines) {
  if (!tests.has(test)) tests.set(test, new Map());
  const files = tests.get(test);
  if (!files.has(file)) files.set(file, new Set());
  for (const n of lines) files.get(file).add(n);
}

function fromNeutral(data, file) {
  const tests = new Map();
  for (const [test, files] of Object.entries(data.tests)) {
    const entries = isPlainObject(files) ? Object.entries(files) : null;
    for (const [src, lines] of entries ?? [[null, null]]) {
      if (!Array.isArray(lines) || !lines.every(isLine)) {
        throw new Error(
          `malformed coverage file ${file}: lines for test ${test} must be ` +
            'arrays of positive integers keyed by file',
        );
      }
      if (lines.length) addLines(tests, test, src, lines);
    }
  }
  return { tests, note: null };
}

/** `tests/a.py::test_x|run` -> `tests/a.py::test_x`; '' is "no test". */
const testOfContext = (ctx) =>
  String(ctx).replace(/\|(run|setup|teardown)$/, '');

function fromCoveragePy(data) {
  const tests = new Map();
  let sawContexts = false;
  for (const [src, entry] of Object.entries(data.files)) {
    if (!isPlainObject(entry?.contexts)) continue;
    sawContexts = true;
    for (const [line, contexts] of Object.entries(entry.contexts)) {
      const n = Number(line);
      if (!isLine(n) || !Array.isArray(contexts)) continue;
      for (const ctx of contexts.map(testOfContext).filter(Boolean)) {
        addLines(tests, ctx, src, [n]);
      }
    }
  }
  const note = sawContexts
    ? null
    : 'the coverage.py JSON carries no per-test contexts; record with ' +
      '--cov-context=test and write it with `coverage json --show-contexts`';
  return { tests, note };
}

/**
 * Read a per-test coverage file.
 *
 * @param {string} file
 * @returns {{tests: Map<string, Map<string, Set<number>>>, note: string|null}}
 */
export function loadCoverage(file) {
  const data = readJson(file);
  if (isPlainObject(data) && data.schema_version === 1) {
    if (isPlainObject(data.tests)) return fromNeutral(data, file);
  } else if (isPlainObject(data) && isPlainObject(data.files)) {
    return fromCoveragePy(data);
  }
  throw new Error(
    `unrecognized coverage format in ${file}: expected coverage.py JSON ` +
      'with contexts, or {"schema_version": 1, "tests": {...}}',
  );
}

/**
 * Compress line numbers into `3-5,9` form.
 *
 * @param {Iterable<number>} lines
 */
export function ranges(lines) {
  const sorted = [...lines].sort((a, b) => a - b);
  const out = [];
  let start = sorted[0];
  let prev = start;
  for (const n of [...sorted.slice(1), Infinity]) {
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    out.push(start === prev ? `${start}` : `${start}-${prev}`);
    [start, prev] = [n, n];
  }
  return out.join(',');
}

function shapeOf(files) {
  return [...files.entries()]
    .filter(([, lines]) => lines.size)
    .map(([file, lines]) => ({ file, ranges: ranges(lines), size: lines.size }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

const byGroupOrder = (a, b) =>
  b.tests.length - a.tests.length || (a.tests[0] < b.tests[0] ? -1 : 1);

/**
 * Group tests with identical, non-empty covered-line sets.
 *
 * @param {Map<string, Map<string, Set<number>>>} tests
 */
export function groupOverlaps(tests) {
  const byShape = new Map();
  for (const [test, files] of tests) {
    const shape = shapeOf(files);
    if (!shape.length) continue;
    const key = JSON.stringify(shape.map(({ file, ranges: r }) => [file, r]));
    if (!byShape.has(key)) byShape.set(key, { shape, tests: [] });
    byShape.get(key).tests.push(test);
  }
  const groups = [...byShape.values()]
    .filter((g) => g.tests.length >= 2)
    .map(({ shape, tests: members }) => ({
      tests: members.sort(),
      line_count: shape.reduce((sum, f) => sum + f.size, 0),
      shared_lines: shape.map(({ file, ranges: r }) => ({ file, ranges: r })),
      caveat: CAVEAT,
    }))
    .sort(byGroupOrder);
  let testsWithCoverage = 0;
  for (const g of byShape.values()) testsWithCoverage += g.tests.length;
  return { testsWithCoverage, groups };
}
