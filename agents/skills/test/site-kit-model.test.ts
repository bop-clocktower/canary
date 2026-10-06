import { describe, expect, it } from 'vitest';
import {
  ABSENT,
  ageDays,
  DARK_AFTER_DAYS,
  formatMeasure,
  isDark,
  logicalRuns,
  passCounts,
  percent,
  suiteKey,
} from '../lib/site-kit/model.js';
import { validateDocument } from '../lib/contracts/validate.mjs';
import {
  assessment,
  DAY,
  iso,
  NOW,
  registerRow,
  result,
  runRecord,
  SCOPE,
  siteFeed,
} from './site-kit-helpers.js';

describe('site-kit model (#1151 phase 3)', () => {
  it('pins DARK_AFTER_DAYS to the spec value (D15)', () => {
    expect(DARK_AFTER_DAYS).toBe(7);
  });

  it.each([
    [0, 0, ABSENT],
    [996, 1000, '99.6%'],
    [999, 1000, '99.9%'],
    [1999, 2000, '99.9%'],
    [2, 2, '100.0%'],
    [1, 3, '33.3%'],
  ])('percent(%i, %i) is %s: rounded down, never up to 100', (n, d, out) => {
    expect(percent(n, d)).toBe(out);
  });

  it('counts a recovered flake as a pass and leaves skips out', () => {
    const t = {
      passed: 3,
      failed: 1,
      flaky: 1,
      skipped: 2,
      timed_out: 0,
      interrupted: 0,
      total: 7,
    };
    expect(passCounts(t)).toEqual({ numerator: 4, denominator: 5 });
  });

  it('merges the shards of one run into one logical run', () => {
    const a = runRecord({
      id: 'r9-s1of2',
      shard: { index: 1, total: 2 },
      results: [result({ title: 'a' })],
      finished: iso(NOW - 2 * DAY),
    });
    const b = runRecord({
      id: 'r9-s2of2',
      shard: { index: 2, total: 2 },
      status: 'failed',
      results: [result({ title: 'b', status: 'failed' })],
      finished: iso(NOW - DAY),
    });
    const [run] = logicalRuns([a, b]).get(suiteKey(SCOPE, 'ts-engine'))!;
    expect(run.id).toBe('r9');
    expect(run.status).toBe('failed');
    expect(run.totals.total).toBe(2);
    expect(run.finished).toBe(NOW - DAY);
    expect(run.results.map((r: { title: string }) => r.title)).toEqual([
      'a',
      'b',
    ]);
  });

  it('a shard without results makes the logical run results null (not carried)', () => {
    const a = runRecord({ id: 'x-s1of2', shard: { index: 1, total: 2 } });
    const b = runRecord({
      id: 'x-s2of2',
      shard: { index: 2, total: 2 },
      results: [result()],
    });
    const [run] = logicalRuns([a, b]).get(suiteKey(SCOPE, 'ts-engine'))!;
    expect(run.results).toBeNull();
  });

  it('failed outranks cancelled, which outranks passed', () => {
    const shard = (i: number, status: 'passed' | 'failed' | 'cancelled') =>
      runRecord({ id: `y-s${i}of2`, shard: { index: i, total: 2 }, status });
    const state = (...runs: ReturnType<typeof runRecord>[]) =>
      logicalRuns(runs).get(suiteKey(SCOPE, 'ts-engine'))![0].status;
    expect(state(shard(1, 'passed'), shard(2, 'cancelled'))).toBe('cancelled');
    expect(state(shard(1, 'failed'), shard(2, 'cancelled'))).toBe('failed');
    expect(state(shard(1, 'passed'), shard(2, 'passed'))).toBe('passed');
  });

  it('orders each suite newest first and keeps suites apart', () => {
    const runs = [
      runRecord({ id: 'old', finished: iso(NOW - 3 * DAY) }),
      runRecord({ id: 'new', finished: iso(NOW - DAY) }),
      runRecord({ id: 'e2e', suite: 'e2e' }),
    ];
    const bySuite = logicalRuns(runs);
    expect(
      bySuite
        .get(suiteKey(SCOPE, 'ts-engine'))!
        .map((r: { id: string }) => r.id),
    ).toEqual(['new', 'old']);
    expect(bySuite.get(suiteKey(SCOPE, 'e2e'))!).toHaveLength(1);
  });

  it('is dark only after DARK_AFTER_DAYS have fully passed', () => {
    expect(isDark(NOW - 7 * DAY, NOW)).toBe(false);
    expect(isDark(NOW - 7 * DAY - 1, NOW)).toBe(true);
  });

  it('ages a timestamp in whole days', () => {
    expect(ageDays(iso(NOW - 10 * DAY - 5), NOW)).toBe(10);
  });

  it.each([
    [0.012, 'ratio', '1.2%'],
    [0.9999, 'ratio', '99.9%'],
    [0.57, 'ratio', '57.0%'],
    [1234.4, 'ms', '1234 ms'],
    [3, 'count', '3'],
    [null, 'ratio', ABSENT],
    [true, 'count', 'yes'],
    [false, 'count', 'no'],
  ])('formatMeasure(%s, %s) is %s', (v, unit, out) => {
    expect(formatMeasure(v, unit)).toBe(out);
  });

  it('the test builders produce feeds the contract accepts', () => {
    const doc = siteFeed({
      suites: [{ scope: SCOPE, suite: 'ts-engine' }],
      runs: [runRecord({ results: [result(), result({ title: 'u' })] })],
      assessments: [assessment()],
      register: [registerRow()],
    });
    const v = validateDocument(doc);
    expect(v.errors).toEqual([]);
    expect(v.valid).toBe(true);
  });
});
