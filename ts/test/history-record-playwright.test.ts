/**
 * Playwright JSON for `canary history record` (#956).
 *
 * The reader mirrors canary-test-reporter's `parse.mjs` classify + naming so
 * two canary readers of one report agree, and adds what the store needs on top:
 * per-test and per-run `duration_ms`, and a `[project]` suffix so the same spec
 * on two browsers does not merge into one history.
 *
 * Fixtures are synthetic.
 */
import { describe, expect, it } from 'vitest';

import {
  buildRunFromReport,
  countReportResults,
  detectReportShape,
} from '../src/history/run-recorder.js';

const CTX = {
  suite: 'web',
  repo: 'acme/widgets',
  branch: 'main',
  commitSha: 'deadbeefcafe',
  nowMs: 1_754_000_000_000,
};

interface Attempt {
  status: string;
  duration: number;
  error?: { message: string };
}

function pwTest(
  status: string,
  attempts: Attempt[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { status, results: attempts, ...extra };
}

function spec(title: string, tests: unknown[]): Record<string, unknown> {
  return { title, file: 'checkout.spec.ts', tests };
}

function report(
  specs: unknown[],
  stats: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    stats,
    suites: [
      {
        title: 'checkout.spec.ts',
        file: 'checkout.spec.ts',
        specs: [],
        suites: [{ title: 'cart', specs }],
      },
    ],
  };
}

const PASS = (d = 10): Attempt => ({ status: 'passed', duration: d });
const FAIL = (d = 10, message = 'boom'): Attempt => ({
  status: 'failed',
  duration: d,
  error: { message },
});

describe('Playwright report reader', () => {
  it('detects a Playwright report by its top-level suites array', () => {
    expect(detectReportShape({ suites: [] })).toBe('playwright');
    expect(detectReportShape({ testResults: [] })).toBe('vitest');
    expect(detectReportShape({ suites: [], testResults: [] })).toBe('vitest');
    expect(detectReportShape({ specs: [] })).toBe('unknown');
  });

  it('counts zero tests in a report with no specs', () => {
    expect(countReportResults({ suites: [] })).toBe(0);
    expect(countReportResults(report([]))).toBe(0);
  });

  it('counts every test across nested suites', () => {
    const r = report([
      spec('adds item', [pwTest('expected', [PASS()])]),
      spec('removes item', [pwTest('expected', [PASS()])]),
    ]);
    expect(countReportResults(r)).toBe(2);
  });

  it('flattens nested suites into suite-path names', () => {
    const r = report([spec('adds item', [pwTest('expected', [PASS()])])]);
    const built = buildRunFromReport('playwright', r, CTX);
    expect(built.results[0]!.test_name).toBe(
      'checkout.spec.ts > cart > adds item',
    );
    expect(built.results[0]!.test_file).toBe('checkout.spec.ts');
  });

  it('maps every Playwright status into the canary vocabulary', () => {
    const r = report([
      spec('expected', [pwTest('expected', [PASS()])]),
      spec('unexpected', [pwTest('unexpected', [FAIL()])]),
      spec('flaky', [pwTest('flaky', [FAIL(), PASS()])]),
      spec('skipped', [pwTest('skipped', [])]),
      spec('timed out', [pwTest('timedOut', [FAIL()])]),
      spec('interrupted', [pwTest('interrupted', [FAIL()])]),
      spec('retry then pass', [pwTest('unexpected', [FAIL(), PASS()])]),
    ]);
    const built = buildRunFromReport('playwright', r, CTX);
    const byName = Object.fromEntries(
      built.results.map((t) => [t.test_name.split(' > ').pop(), t.status]),
    );
    expect(byName).toEqual({
      expected: 'passed',
      unexpected: 'failed',
      flaky: 'flaky',
      skipped: 'skipped',
      'timed out': 'failed',
      interrupted: 'failed',
      'retry then pass': 'flaky',
    });
    expect(built.run).toMatchObject({
      total: 7,
      passed: 1,
      failed: 3,
      flaky: 2,
      skipped: 1,
    });
  });

  it('keeps the failure message only for a failed test', () => {
    const r = report([
      spec('fails', [pwTest('unexpected', [FAIL(5, 'x'.repeat(3000))])]),
      spec('flakes', [pwTest('flaky', [FAIL(5, 'first'), PASS()])]),
    ]);
    const built = buildRunFromReport('playwright', r, CTX);
    expect(built.results[0]!.error_text).toHaveLength(2000);
    expect(built.results[1]!.error_text ?? null).toBeNull();
  });

  it('sums every attempt into the per-test duration', () => {
    const r = report([spec('flaky', [pwTest('flaky', [FAIL(120), PASS(80)])])]);
    const built = buildRunFromReport('playwright', r, CTX);
    expect(built.results[0]!.duration_ms).toBe(200);
  });

  it('takes the run duration and timestamp from stats when present', () => {
    const r = report([spec('a', [pwTest('expected', [PASS(100)])])], {
      duration: 4321.6,
      startTime: '2026-09-01T12:00:00.000Z',
    });
    const built = buildRunFromReport('playwright', r, CTX);
    expect(built.run.duration_ms).toBe(4322);
    expect(built.run.timestamp).toBe('2026-09-01T12:00:00.000+00:00');
    expect(built.run.run_id).toMatch(/^web-deadbeef-\d+$/);
  });

  it('falls back to the summed test durations and the injected clock', () => {
    const r = report([
      spec('a', [pwTest('expected', [PASS(100)])]),
      spec('b', [pwTest('expected', [PASS(50)])]),
    ]);
    const built = buildRunFromReport('playwright', r, CTX);
    expect(built.run.duration_ms).toBe(150);
    expect(built.run.timestamp).toBe(
      new Date(CTX.nowMs).toISOString().replace('Z', '+00:00'),
    );
  });

  it('suffixes the project name and appends a distinct test title', () => {
    const r = report([
      spec('adds item', [
        pwTest('expected', [PASS()], { projectName: 'chromium' }),
        pwTest('expected', [PASS()], {
          projectName: 'webkit',
          title: 'on mobile',
        }),
      ]),
    ]);
    const names = buildRunFromReport('playwright', r, CTX).results.map(
      (t) => t.test_name,
    );
    expect(names).toEqual([
      'checkout.spec.ts > cart > adds item [chromium]',
      'checkout.spec.ts > cart > adds item > on mobile [webkit]',
    ]);
  });

  it('still converts vitest reports through the same dispatch', () => {
    const built = buildRunFromReport(
      'vitest',
      {
        startTime: 1,
        testResults: [
          {
            name: 'a.test.ts',
            assertionResults: [{ fullName: 't', status: 'passed' }],
          },
        ],
      },
      CTX,
    );
    expect(built.run.total).toBe(1);
  });
});
