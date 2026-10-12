/**
 * A vitest file that fails OUTSIDE any test must not record as a clean run.
 *
 * When a test file cannot load (a missing import, a syntax error) or a
 * file-level hook throws, vitest's JSON reporter writes that file as
 * `status: "failed"` with the error in `message` and -- for a load failure --
 * an EMPTY `assertionResults`. The recorder reads only `assertionResults`, so
 * the failure vanishes: the run is stored with `failed: 0` while vitest itself
 * exited non-zero. Fixture shape taken from a real `vitest --reporter=json`
 * run (vitest 3.x) with one passing file and one file whose import is missing.
 */

import { describe, expect, it } from 'vitest';

import { buildRunFromReport } from '../src/history/run-recorder.js';

const CTX = {
  suite: 'unit',
  repo: 'o/r',
  branch: 'main',
  commitSha: 'deadbeef',
  nowMs: 1_754_000_000_000,
};

const REPORT = {
  success: false,
  numFailedTestSuites: 1,
  startTime: 1_754_000_000_000,
  testResults: [
    {
      name: '/repo/src/a.test.ts',
      status: 'passed',
      message: '',
      assertionResults: [
        { fullName: 'parse handles empty', status: 'passed', duration: 1 },
      ],
    },
    {
      name: '/repo/src/c.test.ts',
      status: 'failed',
      message:
        "Cannot find module './missing.js' imported from /repo/src/c.test.ts",
      assertionResults: [],
    },
  ],
};

describe('vitest file-level failure', () => {
  it('does not record a run whose test file failed to load as failure-free', () => {
    const built = buildRunFromReport('vitest', REPORT, CTX);
    expect(built.run.failed).toBeGreaterThan(0);
  });
});
