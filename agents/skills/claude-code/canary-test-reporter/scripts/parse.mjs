// parse -- full-fidelity Playwright JSON parser (self-contained). Ported
// behavior-for-behavior from the Python original.
//
// Walks the Playwright JSON reporter's nested suites/specs/tests and classifies
// each test as passed, failed, flaky, or skipped. A failed/unexpected test with
// a passing retry is flaky and carries no error. Leading non-JSON banners are
// stripped before parsing (matches the reporter's defensive indexOf('{')).

import fs from 'node:fs';

/**
 * @typedef {{title: string, status: string, file: (string|null),
 *            line: (number|null), duration_ms: (number|null),
 *            error: (string|null)}} TestResult
 */

/** Build a TestResult with the Python dataclass defaults (absent -> null). */
export function TestResult(fields) {
  return {
    title: fields.title,
    status: fields.status,
    file: fields.file ?? null,
    line: fields.line ?? null,
    duration_ms: fields.duration_ms ?? null,
    error: fields.error ?? null,
  };
}

/**
 * @typedef {{total: number, passed: number, failed: number, flaky: number,
 *            skipped: number, duration_ms: number,
 *            results: TestResult[]}} ReportData
 */

/** Build a ReportData (mirrors the Python dataclass; all fields required). */
export function ReportData(fields) {
  return {
    total: fields.total,
    passed: fields.passed,
    failed: fields.failed,
    flaky: fields.flaky,
    skipped: fields.skipped,
    duration_ms: fields.duration_ms,
    results: fields.results,
  };
}

function isObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

// Mirror Python dict.get: `.get` on a non-dict (str/list/number/None) raises
// AttributeError, which parseResults converts into a structured error. Here a
// non-object access throws TypeError, caught by the same conversion.
function dget(obj, key, dflt) {
  if (!isObject(obj)) throw new TypeError('value is not an object');
  return key in obj ? obj[key] : dflt;
}

// Mirror Python's `container or []` for a for-loop target. Python truthiness
// differs from JS: an empty object `{}` and empty string `""` are FALSY in
// Python but TRUTHY in JS. A naive `x || []` would turn `{"suites": {}}` into a
// thrown "unexpected structure" (JS iterates the truthy `{}`) where Python
// quietly iterates nothing -- flipping a CI pass into a fail. So:
//   - any Python-falsy value (null/undefined/false/0/""/[]/{})  -> [] (iterate nothing)
//   - an Array                                                  -> the array
//   - any other truthy value (non-empty object/string/number)   -> returned as-is,
//     so `for...of` / `.some` reproduces Python's iterate-then-`.get`-fails path
//     (a string iterates its chars; a non-empty object/number is non-iterable and
//     throws), which surfaces as the same "unexpected structure" error.
function asItems(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.keys(v).length ? v : [];
  if (v && typeof v !== 'object') return v; // non-empty string / truthy number
  return []; // null/undefined/false/0/""
}

/** Classify a raw Playwright status into passed/failed/flaky/skipped. */
function classify(rawStatus, testResults) {
  if (rawStatus === 'skipped' || rawStatus === 'pending') return 'skipped';
  if (rawStatus === 'passed' || rawStatus === 'expected') return 'passed';
  if (rawStatus === 'flaky') return 'flaky';
  if (rawStatus === 'failed' || rawStatus === 'unexpected') {
    const hasPassingRetry = testResults.some((r) => {
      const s = dget(r, 'status', undefined);
      return s === 'passed' || s === 'expected';
    });
    return hasPassingRetry ? 'flaky' : 'failed';
  }
  return 'failed';
}

/** Parse a Playwright JSON results file into a full ReportData. */
export function parseResults(resultsPath) {
  if (!fs.existsSync(resultsPath)) {
    return ReportData({
      total: 0,
      passed: 0,
      failed: 0,
      flaky: 0,
      skipped: 0,
      duration_ms: 0,
      results: [],
    });
  }

  let text = fs.readFileSync(resultsPath, 'utf8');
  const braceAt = text.indexOf('{');
  if (braceAt > 0) text = text.slice(braceAt);

  let data;
  try {
    data = JSON.parse(text);
  } catch (exc) {
    throw new Error(`results file is not valid JSON: ${exc.message}`);
  }

  if (!isObject(data)) {
    throw new Error("results file's top-level value must be an object");
  }

  const results = [];
  try {
    for (const suite of asItems(data.suites)) {
      processSuite(suite, results, '', '');
    }
  } catch (exc) {
    if (exc instanceof TypeError) {
      throw new Error(
        `results file has an unexpected structure: ${exc.message}`,
      );
    }
    throw exc;
  }

  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const flaky = results.filter((r) => r.status === 'flaky').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const totalMs = results.reduce((acc, r) => acc + (r.duration_ms || 0), 0);

  return ReportData({
    total: results.length,
    passed,
    failed,
    flaky,
    skipped,
    duration_ms: totalMs,
    results,
  });
}

function processSuite(suite, results, parentPath, suiteFile) {
  const suiteTitle = dget(suite, 'title', '');
  const suitePath = parentPath ? `${parentPath} > ${suiteTitle}` : suiteTitle;
  const currentFile = dget(suite, 'file', undefined) || suiteFile;

  for (const child of asItems(dget(suite, 'suites', []))) {
    processSuite(child, results, suitePath, currentFile);
  }

  for (const spec of asItems(dget(suite, 'specs', []))) {
    const specTitle = dget(spec, 'title', '');
    const specPath = `${suitePath} > ${specTitle}`;
    const specLocation = dget(spec, 'location', undefined) || {};
    for (const test of asItems(dget(spec, 'tests', []))) {
      const rawTestTitle = dget(test, 'title', null);
      const testLocation = dget(test, 'location', undefined) || {};
      const testResults = asItems(dget(test, 'results', undefined));
      const rawStatus = dget(test, 'status', 'unknown');

      const status = classify(rawStatus, testResults);

      let error = null;
      let duration = null;
      if (testResults.length) {
        const last = testResults[testResults.length - 1];
        duration = dget(last, 'duration', null);
        if (status === 'failed') {
          const err = dget(last, 'error', undefined) || {};
          error = dget(err, 'message', null);
          if (error === null || error === undefined) {
            const errs = dget(last, 'errors', undefined) || [];
            if (errs.length) error = dget(errs[0], 'message', null);
          }
        }
      }

      const title =
        rawTestTitle && rawTestTitle !== specTitle
          ? `${specPath} > ${rawTestTitle}`
          : specPath;

      const testLine = dget(testLocation, 'line', null);
      const line =
        testLine !== null && testLine !== undefined
          ? testLine
          : dget(specLocation, 'line', null);

      results.push(
        TestResult({
          title,
          status,
          file:
            dget(testLocation, 'file', undefined) ||
            dget(specLocation, 'file', undefined) ||
            currentFile ||
            null,
          line,
          duration_ms: duration,
          error,
        }),
      );
    }
  }
}
