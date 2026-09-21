// canary-misfit -- reading flows out of a Playwright JSON report (#592).
//
// A "flow" is one Playwright test: did it survive, how long did it take, did it
// retry. Kept in its own module rather than inside verdict.mjs so each function
// stays small enough to read at a glance (and under the complexity budget the
// perf gate enforces).
//
// Self-contained on purpose: the skill family does not share a parser across
// skills (canary-fail-fast keeps its own copy), because a skill has to run with
// nothing installed.

import fs from 'node:fs';

/** @typedef {{id: string, title: string, file: string|null, status: string,
 *             duration_ms: number, retries: number}} Flow */

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// A literal open-brace inside a string literal is invisible to the complexity
// analyzer's brace counter, which then reads the enclosing function as running
// to the end of the file (measured: readReport at "90 lines, complexity 21"
// when it is 20 lines and complexity 6). Building the character keeps the
// measurement honest -- canary-fail-fast's parse.mjs has the same
// `indexOf('{')` and is grandfathered into the absolute baseline.
const JSON_OPEN = String.fromCharCode(123);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** Parse the report file, with a named error for each way it can be unusable. */
function readReport(resultsPath) {
  if (!fs.existsSync(resultsPath)) {
    throw new Error(`results file not found: ${resultsPath}`);
  }
  let text = fs.readFileSync(resultsPath, 'utf8');
  // A reporter banner ahead of the payload is normal; the JSON starts at the
  // first brace.
  const braceAt = text.indexOf(JSON_OPEN);
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
  return data;
}

/** Every attempt recorded for one spec, oldest first. */
function attemptsOf(spec) {
  const attempts = [];
  for (const test of asArray(spec.tests)) {
    if (isObject(test)) attempts.push(...asArray(test.results));
  }
  return attempts;
}

function totalDuration(attempts) {
  let total = 0;
  for (const attempt of attempts) {
    if (isObject(attempt) && typeof attempt.duration === 'number') {
      total += attempt.duration;
    }
  }
  return total;
}

function lastStatus(attempts) {
  const last = attempts[attempts.length - 1];
  if (isObject(last) && typeof last.status === 'string') return last.status;
  return 'unknown';
}

function titleOf(spec) {
  return typeof spec.title === 'string' ? spec.title : '(untitled)';
}

function idOf(spec, file, title) {
  if (typeof spec.id === 'string' && spec.id) return spec.id;
  return `${file}:${title}`;
}

/** @returns {Flow} */
function flowFromSpec(spec, file) {
  const attempts = attemptsOf(spec);
  const title = titleOf(spec);
  return {
    id: idOf(spec, file, title),
    title,
    file: file || null,
    status: lastStatus(attempts),
    duration_ms: totalDuration(attempts),
    // Playwright records one result per attempt, so anything past the first is
    // a retry -- which is a degradation signal, not a detail.
    retries: Math.max(0, attempts.length - 1),
  };
}

function walkSuites(suites, inheritedFile, flows) {
  for (const suite of suites) {
    if (!isObject(suite)) continue;
    const file = typeof suite.file === 'string' ? suite.file : inheritedFile;
    for (const spec of asArray(suite.specs)) {
      if (isObject(spec)) flows.push(flowFromSpec(spec, file));
    }
    walkSuites(asArray(suite.suites), file, flows);
  }
}

/** Flatten a Playwright JSON report into flows. @returns {Flow[]} */
export function readFlows(resultsPath) {
  const flows = [];
  walkSuites(asArray(readReport(resultsPath).suites), '', flows);
  return flows;
}
