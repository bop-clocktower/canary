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

  it('records the load failure as one failed row named after its file', () => {
    const built = buildRunFromReport('vitest', REPORT, CTX);
    expect(built.run).toMatchObject({ total: 2, passed: 1, failed: 1 });
    const row = built.results.find((r) => r.status === 'failed');
    expect(row).toMatchObject({
      test_file: '/repo/src/c.test.ts',
      test_name: '/repo/src/c.test.ts (file failed outside any test)',
      error_text:
        "Cannot find module './missing.js' imported from /repo/src/c.test.ts",
    });
  });

  it('records a throwing file hook alongside the tests that passed', () => {
    const hookThrew = {
      testResults: [
        {
          name: '/repo/src/h.test.ts',
          status: 'failed',
          message: 'afterAll hook timed out',
          assertionResults: [{ fullName: 'h works', status: 'passed' }],
        },
      ],
    };
    const built = buildRunFromReport('vitest', hookThrew, CTX);
    expect(built.run).toMatchObject({ total: 2, passed: 1, failed: 1 });
  });

  it('does not add a row for a file whose only failures are its tests', () => {
    const assertionFailed = {
      testResults: [
        {
          name: '/repo/src/b.test.ts',
          status: 'failed',
          message: '',
          assertionResults: [
            { fullName: 'b breaks', status: 'failed', failureMessages: ['x'] },
          ],
        },
      ],
    };
    const built = buildRunFromReport('vitest', assertionFailed, CTX);
    expect(built.run).toMatchObject({ total: 1, failed: 1 });
  });
});
