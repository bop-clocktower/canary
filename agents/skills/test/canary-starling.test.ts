import { describe, expect, it } from 'vitest';
import {
  historyToRun,
  RUNS_PER_SUITE,
  selectRuns,
} from '../claude-code/canary-starling/scripts/runs.mjs';
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
