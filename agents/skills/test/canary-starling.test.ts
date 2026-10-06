import { describe, expect, it } from 'vitest';
import {
  historyToRun,
  RUNS_PER_SUITE,
  selectRuns,
} from '../claude-code/canary-starling/scripts/runs.mjs';
import { flakyTests } from '../claude-code/canary-starling/scripts/flaky.mjs';
import { registerRows } from '../claude-code/canary-starling/scripts/register.mjs';
import {
  ciReadyAssessments,
  CI_READY_METRICS,
} from '../claude-code/canary-starling/scripts/assess.mjs';
import { validateDocument } from '../lib/contracts/validate.mjs';

const SCOPE = { id: 'canary', env: 'ci' };

const historyRow = (over: Record<string, unknown> = {}) => ({
  run_id: 'r1',
  suite: 'ts-engine',
  branch: 'main',
  commit_sha: 'abc1234',
  timestamp: '2026-10-06T10:00:00Z',
  duration_ms: 60000,
  total: 2,
  passed: 1,
  failed: 1,
  flaky: 0,
  skipped: 0,
  schema_version: 3,
  tests: [
    { test_name: 'a', test_file: 'test/a.test.ts', status: 'passed' },
    {
      test_name: 'b',
      test_file: 'test/b.test.ts',
      status: 'failed',
      error_text: 'boom',
    },
  ],
  ...over,
});

// historyToRun returns {run: null} for a left-out row; narrow for the tests
// that expect a record, so a null fails loudly instead of as a TypeError.
const runOf = (row: ReturnType<typeof historyRow>) => {
  const { run, skipped } = historyToRun(row, SCOPE);
  if (run === null) throw new Error(`expected a run record: ${skipped}`);
  return run;
};

describe('historyToRun (assumption C)', () => {
  it('derives started_at from timestamp minus duration and validates', () => {
    const run = runOf(historyRow());
    expect(run.run.finished_at).toBe('2026-10-06T10:00:00Z');
    expect(run.run.started_at).toBe('2026-10-06T09:59:00.000Z');
    expect(run.run.status).toBe('failed');
    expect(run.results.map((r: { status: string }) => r.status)).toEqual([
      'passed',
      'failed',
    ]);
    expect(validateDocument(run, { layer: 'run' }).errors).toEqual([]);
  });

  it.each([
    ['no timestamp', { timestamp: undefined }],
    ['no duration', { duration_ms: null }],
    [
      'an unknown test status',
      { tests: [{ test_name: 'a', test_file: 'a.ts', status: 'todo' }] },
    ],
    [
      'an absolute test path',
      { tests: [{ test_name: 'a', test_file: '/abs/a.ts', status: 'passed' }] },
    ],
  ])('leaves out a row with %s, naming why', (_why, over) => {
    const out = historyToRun(historyRow(over), SCOPE);
    expect(out.run).toBeNull();
    expect(out.skipped).toMatch(/r1/);
  });

  it('carries results null, totals from the counts, for a count-only row', () => {
    const run = runOf(historyRow({ tests: undefined }));
    expect(run.results).toBeNull();
    expect(run.totals).toEqual({
      passed: 1,
      failed: 1,
      flaky: 0,
      skipped: 0,
      timed_out: 0,
      interrupted: 0,
      total: 2,
    });
    expect(validateDocument(run, { layer: 'run' }).errors).toEqual([]);
  });
});

describe('selectRuns (D15)', () => {
  const runAt = (i: number, suite = 'ts-engine') =>
    historyToRun(
      historyRow({
        run_id: `r${i}`,
        suite,
        timestamp: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
      }),
      SCOPE,
    ).run;

  it('keeps the newest 30 per suite, results only on the newest', () => {
    const all = [...Array(35).keys()]
      .map((i) => runAt(i))
      .concat(runAt(0, 'api'));
    const { feed, window } = selectRuns(all);
    const engine = feed.filter((r: any) => r.run.suite === 'ts-engine');
    expect(RUNS_PER_SUITE).toBe(30);
    expect(engine).toHaveLength(30);
    expect(engine[0].run.id).toBe('r34');
    expect(engine.filter((r: any) => r.results !== null)).toHaveLength(1);
    expect(
      feed.filter((r: any) => r.run.suite === 'api')[0].results,
    ).not.toBeNull();
    // The window keeps every kept run's results, for flaky[] (Task 12).
    expect(window.every((r: any) => r.results !== null)).toBe(true);
    for (const r of feed)
      expect(validateDocument(r, { layer: 'run' }).errors).toEqual([]);
  });
});

describe('flakyTests (D13)', () => {
  it('counts a test once, with flaky runs over runs that carry results', () => {
    const mk = (i: number, status: string) =>
      historyToRun(
        historyRow({
          run_id: `r${i}`,
          timestamp: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
          passed: status === 'passed' ? 1 : 0,
          flaky: status === 'flaky' ? 1 : 0,
          failed: 0,
          total: 1,
          tests: [{ test_name: 'a', test_file: 'test/a.test.ts', status }],
        }),
        SCOPE,
      ).run;
    const counted = historyToRun(
      historyRow({ run_id: 'c', tests: undefined }),
      SCOPE,
    ).run;
    const rows = flakyTests([
      mk(1, 'flaky'),
      mk(2, 'passed'),
      mk(3, 'flaky'),
      counted,
    ]);
    expect(rows).toEqual([
      {
        scope: SCOPE,
        suite: 'ts-engine',
        title: 'a',
        file: 'test/a.test.ts',
        flaky_runs: 2,
        window_runs: 3,
      },
    ]);
  });
});

describe('registerRows (fork C)', () => {
  const ledgerRow = (over = {}) => ({
    test: 'adds',
    file: 'tests/cart.test.ts',
    kind: 'skipped',
    marker: 'it.skip',
    commit: 'abc1234',
    author: 'Someone',
    date: '2026-10-01T12:00:00+02:00',
    reason: 'chore: skip cart',
    cause: '',
    issue: '',
    ...over,
  });

  it('maps a ledger row, without author, empty cause/issue as null', () => {
    const { rows, skipped } = registerRows([ledgerRow()], SCOPE);
    expect(skipped).toEqual([]);
    expect(rows).toEqual([
      {
        scope: SCOPE,
        title: 'adds',
        file: 'tests/cart.test.ts',
        kind: 'skipped',
        reason: 'chore: skip cart',
        recorded_at: '2026-10-01T12:00:00+02:00',
        commit: 'abc1234',
        cause: null,
        issue: null,
      },
    ]);
  });

  it('leaves out a row with no date, commit or reason, and counts it', () => {
    const { rows, skipped } = registerRows(
      [ledgerRow({ date: '' }), ledgerRow({ commit: '' })],
      SCOPE,
    );
    expect(rows).toEqual([]);
    expect(skipped).toHaveLength(2);
  });
});

describe('ciReadyAssessments (P1, crit 8)', () => {
  const NOW = '2026-10-06T12:00:00.000Z';
  const report = (checks: object[]) => ({
    observed_at: '2026-10-06T11:00:00.000Z',
    verdict: 'incomplete',
    checked: 1,
    checks,
  });

  it('is not-assessed for every metric when no report was supplied — planted absence', () => {
    const out = ciReadyAssessments(null, SCOPE, { now: NOW, source: null });
    expect(out.map((a: any) => a.metric)).toEqual(CI_READY_METRICS);
    for (const a of out) {
      expect(a.status).toBe('not-assessed');
      expect(a.value).toBeNull();
      expect(a.reason).toMatch(/no ci-ready report/);
      expect(validateDocument(a, { layer: 'assessment' }).errors).toEqual([]);
    }
  });

  it('carries a skipped check as not-assessed with its own reason (no inventory)', () => {
    const skip = {
      name: 'coverage-depth',
      verdict: 'skip',
      reason:
        'no .canary/test-inventory.json: run `canary inventory` to produce it',
      measure: null,
    };
    const a = ciReadyAssessments(report([skip]), SCOPE, {
      now: NOW,
      source: 'ci-ready.json',
    })[0];
    expect(a).toMatchObject({
      status: 'not-assessed',
      value: null,
      reason: skip.reason,
      observed_at: '2026-10-06T11:00:00.000Z',
    });
  });

  it('maps pass/warn/fail with a measure to healthy/degraded/critical', () => {
    const m = { value: 0.2, unit: 'ratio', denominator: 5 };
    const out = ciReadyAssessments(
      report(
        ['pass', 'warn', 'fail'].map((verdict) => ({
          name: 'flakiness',
          verdict,
          reason: 'x',
          measure: m,
        })),
      ),
      SCOPE,
      { now: NOW, source: 'ci-ready.json' },
    );
    const flak = out.filter((a: any) => a.metric === 'flakiness');
    expect(flak.map((a: any) => a.status)).toEqual([
      'healthy',
      'degraded',
      'critical',
    ]);
    expect(flak[0]).toMatchObject({
      value: 0.2,
      unit: 'ratio',
      evidence: { tier: null, denominator: 5 },
      sources: ['ci-ready.json'],
    });
    for (const a of out)
      expect(validateDocument(a, { layer: 'assessment' }).errors).toEqual([]);
  });

  it('a check with a verdict but no measure is not-assessed (thin window, structural zero)', () => {
    const out = ciReadyAssessments(
      report([
        {
          name: 'flakiness',
          verdict: 'pass',
          reason: 'structural zero',
          measure: null,
        },
      ]),
      SCOPE,
      { now: NOW, source: 'r.json' },
    );
    expect(out.find((a: any) => a.metric === 'flakiness')).toMatchObject({
      status: 'not-assessed',
      reason: 'structural zero',
    });
  });

  it('names a metric the report does not carry', () => {
    const out = ciReadyAssessments(report([]), SCOPE, {
      now: NOW,
      source: 'r.json',
    });
    expect(out.find((a: any) => a.metric === 'suite-runtime')?.reason).toMatch(
      /no suite-runtime check/,
    );
  });
});
