// parse -- minimal Playwright JSON parser (failing tests only, self-contained).
// Ported behavior-for-behavior from the Python original.
//
// Walks the Playwright JSON reporter's nested suites/specs/tests and returns the
// real failures. A failed/unexpected test with a passing retry is flaky and
// excluded; without one it is a failure. Leading non-JSON banners are stripped
// before parsing (matches the reporter's defensive indexOf('{')).

import fs from 'node:fs';

/**
 * @typedef {{title: string, status: string, file: (string|null),
 *            line: (number|null), error: (string|null)}} Failure
 */

/** Build a Failure with the Python dataclass defaults (absent -> null). */
export function Failure(fields) {
  return {
    title: fields.title,
    status: fields.status,
    file: fields.file ?? null,
    line: fields.line ?? null,
    error: fields.error ?? null,
  };
}

function isObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

// Mirror Python dict.get: `.get` on a non-dict (str/list/number/None) raises
// AttributeError, which parseFailures converts into a structured error. Here a
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
//     so `for...of` reproduces Python's iterate-then-`.get`-fails path (a string
//     iterates its chars; a non-empty object/number is non-iterable and throws),
//     which surfaces as the same "unexpected structure" error.
function asItems(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.keys(v).length ? v : [];
  if (v && typeof v !== 'object') return v; // non-empty string / truthy number
  return []; // null/undefined/false/0/""
}

/** Parse a Playwright JSON results file, returning only the real failures. */
export function parseFailures(resultsPath) {
  if (!fs.existsSync(resultsPath)) return [];

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

  const failures = [];
  try {
    for (const suite of asItems(data.suites)) {
      processSuite(suite, failures, '', '');
    }
  } catch (exc) {
    if (exc instanceof TypeError) {
      throw new Error(
        `results file has an unexpected structure: ${exc.message}`,
      );
    }
    throw exc;
  }
  return failures;
}

function processSuite(suite, failures, parentPath, suiteFile) {
  const suiteTitle = dget(suite, 'title', '');
  const suitePath = parentPath ? `${parentPath} > ${suiteTitle}` : suiteTitle;
  const currentFile = dget(suite, 'file', undefined) || suiteFile;

  for (const child of asItems(dget(suite, 'suites', []))) {
    processSuite(child, failures, suitePath, currentFile);
  }

  for (const spec of asItems(dget(suite, 'specs', []))) {
    const specPath = `${suitePath} > ${dget(spec, 'title', '')}`;
    const specLocation = dget(spec, 'location', undefined) || {};
    for (const test of asItems(dget(spec, 'tests', []))) {
      const testTitle =
        dget(test, 'title', undefined) || dget(spec, 'title', '');
      const testLocation = dget(test, 'location', undefined) || {};
      const results = asItems(dget(test, 'results', undefined));

      const status = dget(test, 'status', 'unknown');
      if (status !== 'unexpected' && status !== 'failed') continue;

      const hasPassingRetry = results.some((r) => {
        const s = dget(r, 'status', undefined);
        return s === 'passed' || s === 'expected';
      });
      if (hasPassingRetry) continue; // flaky -- excluded from the failure count

      let error = null;
      if (results.length) {
        const last = results[results.length - 1];
        const err = dget(last, 'error', undefined) || {};
        error = dget(err, 'message', undefined);
        if (error === undefined || error === null) {
          const errs = dget(last, 'errors', undefined) || [];
          if (errs.length) {
            error = dget(errs[0], 'message', undefined);
          }
        }
      }

      failures.push(
        Failure({
          title: `${specPath} > ${testTitle}`,
          status,
          file:
            dget(testLocation, 'file', undefined) ||
            dget(specLocation, 'file', undefined) ||
            currentFile,
          line:
            dget(testLocation, 'line', undefined) ||
            dget(specLocation, 'line', undefined) ||
            null,
          error,
        }),
      );
    }
  }
}
