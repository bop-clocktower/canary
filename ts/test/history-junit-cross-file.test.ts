/**
 * JUnit repeated-name collapse must not merge tests from different files.
 *
 * Encoding 3 in `formats/junit-report.ts` folds the same `classname::name`
 * repeated in one report into one row (pytest-rerunfailures). Keyed on the
 * name alone, it also folded two DIFFERENT tests that share a name but live in
 * different files (`file` attribute) -- a real failure in one file plus a pass
 * in the other was recorded as a single `flaky` row, hiding the failure.
 */

import { describe, expect, it } from 'vitest';

import { buildRunFromReport } from '../src/history/run-recorder.js';

const CTX = {
  suite: 'js',
  repo: 'o/r',
  branch: 'main',
  commitSha: 'deadbeef',
  nowMs: 1_754_000_000_000,
};

describe('JUnit cross-file same-name tests', () => {
  it('keeps a failure in one file separate from a pass in another', () => {
    const xml =
      '<testsuites>' +
      '<testsuite name="a"><testcase classname="Button" name="renders" file="a.test.js" time="0.1">' +
      '<failure message="boom"/></testcase></testsuite>' +
      '<testsuite name="b"><testcase classname="Button" name="renders" file="b.test.js" time="0.1"/>' +
      '</testsuite></testsuites>';
    const built = buildRunFromReport('junit', xml, CTX);
    expect(built.run.failed).toBe(1);
  });
});
