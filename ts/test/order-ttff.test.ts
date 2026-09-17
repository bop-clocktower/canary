/**
 * Time-to-first-failure for `canary order` (#460 D7, criterion 7): the
 * estimate `record --order-plan` stores per run, and the report that decides
 * whether ordering helped. A run with no failure is "not measurable", never a
 * win.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ttffReport } from '../src/analysis/order/ttff-report.js';
import { buildOrderPlan } from '../src/analysis/order/rank.js';
import {
  estimateTtff,
  orderOutcome,
  readOrderPlanFile,
} from '../src/history/keys/order-ttff.js';
import type { RunRecord } from '../src/history/record.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

const row = (file: string, status: string, duration_ms: number) => ({
  run_id: 'r',
  suite: 's',
  repo: 'x',
  test_name: `${file} ${status}`,
  test_file: file,
  status,
  duration_ms,
});

describe('estimateTtff', () => {
  const results = [
    row('a.test.ts', 'passed', 100),
    row('b.test.ts', 'passed', 10),
    row('b.test.ts', 'failed', 20),
    row('c.test.ts', 'failed', 5),
  ];

  it('sums durations in file order up to and including the first failing test', () => {
    expect(estimateTtff(['a.test.ts', 'b.test.ts', 'c.test.ts'], results)).toBe(
      130,
    );
    expect(estimateTtff(['c.test.ts', 'a.test.ts', 'b.test.ts'], results)).toBe(
      5,
    );
  });

  it('puts files the order does not name last, in recorded order', () => {
    expect(estimateTtff(['b.test.ts'], results)).toBe(30);
    expect(estimateTtff([], results)).toBe(130);
  });

  it('is null when nothing failed', () => {
    expect(
      estimateTtff(['a.test.ts'], [row('a.test.ts', 'passed', 1)]),
    ).toBeNull();
  });

  it('counts a flaky test as a failure', () => {
    expect(estimateTtff([], [row('a.test.ts', 'flaky', 7)])).toBe(7);
  });
});

describe('orderOutcome and readOrderPlanFile', () => {
  it('reads a real canary order plan and estimates both orders', () => {
    const dir = mkTmp();
    try {
      const plan = buildOrderPlan({
        suite: 's',
        files: ['a.test.ts', 'c.test.ts'],
        runs: [],
        changed: ['c.test.ts'],
        imports: null,
      });
      const path = join(dir, 'plan.json');
      writeFileSync(path, JSON.stringify(plan));
      const read = readOrderPlanFile(path);
      expect(read).toEqual({
        mode: 'diff-only',
        order: ['c.test.ts', 'a.test.ts'],
        declared: ['a.test.ts', 'c.test.ts'],
      });
      const out = orderOutcome(read!, [
        row('a.test.ts', 'passed', 100),
        row('c.test.ts', 'failed', 5),
      ]);
      expect(out).toEqual({
        mode: 'diff-only',
        ttff_ordered_ms_estimate: 5,
        ttff_baseline_ms_estimate: 105,
      });
    } finally {
      rmTmp(dir);
    }
  });

  it('returns null for a file that is not a plan', () => {
    const dir = mkTmp();
    try {
      writeFileSync(join(dir, 'x.json'), '{"nope":1}');
      expect(readOrderPlanFile(join(dir, 'x.json'))).toBeNull();
      expect(readOrderPlanFile(join(dir, 'missing.json'))).toBeNull();
    } finally {
      rmTmp(dir);
    }
  });
});

describe('ttffReport (criterion 7)', () => {
  const run = (
    i: number,
    ordered: number | null,
    baseline: number | null,
  ): RunRecord => ({
    run_id: `r${i}`,
    suite: 's',
    timestamp: `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00+00:00`,
    order: {
      mode: 'history+diff',
      ttff_ordered_ms_estimate: ordered,
      ttff_baseline_ms_estimate: baseline,
    },
  });

  it('counts runs with no failure as not measurable, never as a win', () => {
    const runs = [run(0, null, null), run(1, 5, 50), run(2, null, null)];
    const report = ttffReport(runs, 's');
    expect(report).toMatchObject({
      ordered: 3,
      measurable: 1,
      notMeasurable: 2,
      verdict: 'insufficient',
    });
  });

  it('with 20 measurable runs compares medians over the first 20', () => {
    const runs = Array.from({ length: 22 }, (_, i) =>
      i < 20 ? run(i, 10, 100) : run(i, 999, 1),
    );
    expect(ttffReport(runs, 's')).toMatchObject({
      measurable: 22,
      medianOrderedMs: 10,
      medianBaselineMs: 100,
      verdict: 'lower',
    });
  });

  it('says not-lower when ordering did not beat the baseline', () => {
    const runs = Array.from({ length: 20 }, (_, i) => run(i, 100, 100));
    expect(ttffReport(runs, 's').verdict).toBe('not-lower');
  });

  it('ignores other suites and runs recorded without a plan', () => {
    const other = { ...run(0, 1, 9), suite: 'other' };
    const noPlan: RunRecord = { run_id: 'x', suite: 's' };
    expect(ttffReport([other, noPlan], 's')).toMatchObject({
      ordered: 0,
      measurable: 0,
      verdict: 'insufficient',
    });
  });
});

describe('end to end: record --order-plan, then canary order --report', () => {
  it('stores the estimates on the run and reports them', async () => {
    const dir = mkTmp();
    try {
      const git = (...args: string[]): void => {
        execFileSync(
          'git',
          [
            '-c',
            'user.email=t@example.invalid',
            '-c',
            'user.name=t',
            '-c',
            'commit.gpgsign=false',
            ...args,
          ],
          { cwd: dir },
        );
      };
      git('init', '-q');
      writeFileSync(join(dir, 'a.test.ts'), '');
      writeFileSync(join(dir, 'b.test.ts'), '');
      git('add', '-A');
      git('commit', '-q', '-m', 'base');
      writeFileSync(join(dir, 'a.test.ts'), '// changed\n');
      git('commit', '-q', '-am', 'change a');
      const plan = join(dir, 'plan.json');
      // Declared b, a; the diff ranks a first, so the two estimates differ.
      const res1 = await invokeCanary(
        [
          'order',
          '--suite',
          's',
          'b.test.ts',
          'a.test.ts',
          '--base',
          'HEAD~1',
          '--out',
          plan,
        ],
        { cwd: dir },
      );
      expect(res1.code).toBe(0);
      const report = join(dir, 'v.json');
      writeFileSync(
        report,
        JSON.stringify({
          testResults: [
            {
              name: join(dir, 'b.test.ts'),
              assertionResults: [
                { fullName: 'b', status: 'passed', duration: 40 },
              ],
            },
            {
              name: join(dir, 'a.test.ts'),
              assertionResults: [
                { fullName: 'a', status: 'failed', duration: 2 },
              ],
            },
          ],
        }),
      );
      const store = join(dir, 'h.jsonl');
      const res2 = await invokeCanary(
        [
          'history',
          'record',
          report,
          '--suite',
          's',
          '--commit',
          'abc1234',
          '--path',
          store,
          '--order-plan',
          plan,
        ],
        {
          cwd: dir,
          env: { GITHUB_REPOSITORY: 'acme/x', GITHUB_SHA: undefined },
        },
      );
      expect(res2.code).toBe(0);
      const line = JSON.parse(readFileSync(store, 'utf-8').trim()) as RunRecord;
      expect(line.order).toEqual({
        mode: 'diff-only',
        ttff_ordered_ms_estimate: 2,
        ttff_baseline_ms_estimate: 42,
      });
      const res3 = await invokeCanary(
        ['order', '--report', '--suite', 's', '--path', store, '--json'],
        { cwd: dir },
      );
      expect(res3.code).toBe(0);
      expect(JSON.parse(res3.stdout)).toMatchObject({
        measurable: 1,
        verdict: 'insufficient',
      });
    } finally {
      rmTmp(dir);
    }
  });
});
