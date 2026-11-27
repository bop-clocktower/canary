/**
 * canary-ivy (#615) -- runtime creep over history (spec D6, D7, D12, SC8).
 * Stores are synthetic; timestamps are fixed strings.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_HISTORY,
  THRESHOLDS,
  analyzeRuntime,
  changepoint,
  loadRuns,
  readStore,
} from '../claude-code/canary-ivy/scripts/runtime.mjs';

const tmps: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-ivy-rt-'));
  tmps.push(dir);
  return dir;
}
function writeStore(lines: string[]): string {
  const file = path.join(tmpDir(), 'history-v2.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

afterEach(() => {
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
});

const STEP = [800, 810, 790, 805, 2400, 2390, 2410, 2405];

function run(i: number, tests: object[]) {
  return {
    schema_version: 3,
    run_id: `unit-c0ffee0${i}-170000000${i}`,
    suite: 'unit',
    commit_sha: `c0ffee0${i}`,
    timestamp: `2026-01-0${i + 1}T00:00:00Z`,
    tests,
  };
}

function stepStore() {
  return STEP.map((ms, i) =>
    run(i, [
      {
        test_file: 'tests/dash.spec.ts',
        test_name: 'loads the dashboard',
        status: 'passed',
        duration_ms: ms,
      },
      {
        test_file: 'tests/flat.spec.ts',
        test_name: 'stays flat',
        status: 'passed',
        duration_ms: 100,
      },
      ...(i < 3
        ? [
            {
              test_file: 'tests/new.spec.ts',
              test_name: 'only three runs',
              status: 'passed',
              duration_ms: 5 + i * 1000,
            },
          ]
        : []),
    ]),
  );
}

describe('changepoint', () => {
  const at = (i: number) => ({
    timestamp: `t${i}`,
    commit_sha: null,
    run_id: null,
  });
  const points = (values: number[]) =>
    values.map((ms, i) => ({ ms, at: at(i) }));

  it('names the run where a step began', () => {
    const cp = changepoint(points(STEP));
    expect(cp).toEqual({
      before_median_ms: 802.5,
      after_median_ms: 2402.5,
      gap_ms: 1600,
      observations: 8,
      grew_at: at(4),
    });
  });

  it('reports nothing for a flat series or one under the thresholds', () => {
    expect(changepoint(points([100, 100, 100, 100, 100, 100]))).toBeNull();
    // ratio clears 1.5x but the gap is under 100 ms
    expect(changepoint(points([10, 10, 10, 60, 60, 60]))).toBeNull();
    // gap clears 100 ms but the ratio is under 1.5x
    expect(
      changepoint(points([1000, 1000, 1000, 1200, 1200, 1200])),
    ).toBeNull();
    // a slowdown that recovered is not growth
    expect(changepoint(points([900, 900, 900, 100, 100, 100]))).toBeNull();
  });

  it('needs MIN observations', () => {
    expect(THRESHOLDS.min_observations).toBe(6);
    expect(changepoint(points([1, 1, 1, 900, 900]))).toBeNull();
  });
});

describe('analyzeRuntime', () => {
  it('reports test and file creep, where time went, and its denominators', () => {
    const shuffled = stepStore().reverse();
    const result = analyzeRuntime(shuffled);
    expect(result.denominator).toEqual({
      runs: 8,
      timed_tests: 3,
      series_long_enough: 2,
    });
    expect(result.creep.map((c: { scope: string }) => c.scope)).toEqual([
      'file',
      'test',
    ]);
    const testRow = result.creep[1];
    expect(testRow).toMatchObject({
      file: 'tests/dash.spec.ts',
      test: 'loads the dashboard',
      gap_ms: 1600,
      grew_at: {
        timestamp: '2026-01-05T00:00:00Z',
        commit_sha: 'c0ffee04',
        run_id: 'unit-c0ffee04-1700000004',
      },
    });
    expect(result.creep[0].test).toBeNull();
    expect(result.where_time_went.map((w: { file: string }) => w.file)).toEqual(
      ['tests/dash.spec.ts', 'tests/new.spec.ts', 'tests/flat.spec.ts'],
    );
    const shares = result.where_time_went.map(
      (w: { share: number }) => w.share,
    );
    expect(shares.reduce((a: number, b: number) => a + b, 0)).toBeCloseTo(1, 2);
  });

  it('counts nothing when no test carries a duration', () => {
    const runs = [run(0, [{ test_name: 'x', status: 'passed' }]), run(1, [])];
    const result = analyzeRuntime(runs);
    expect(result.denominator.timed_tests).toBe(0);
    expect(result.creep).toEqual([]);
    expect(result.where_time_went).toEqual([]);
  });

  it('labels a test with no test_file and ignores non-object rows', () => {
    const runs = STEP.map((ms, i) =>
      run(i, [null, 'x', { test_name: 'orphan', duration_ms: ms }]),
    );
    const result = analyzeRuntime(runs);
    expect(result.creep[0].file).toBe('(no file)');
    expect(result.denominator.timed_tests).toBe(1);
  });

  it('gives every file a zero share when all durations are zero', () => {
    const runs = [run(0, [{ test_file: 'a', test_name: 'z', duration_ms: 0 }])];
    expect(analyzeRuntime(runs).where_time_went).toEqual([
      { file: 'a', median_ms: 0, share: 0 },
    ]);
  });
});

describe('readStore / loadRuns', () => {
  it('reads one record per non-blank line', () => {
    const file = writeStore(stepStore().map((r) => JSON.stringify(r)));
    expect(loadRuns(file)).toHaveLength(8);
  });

  it('marks a missing default store dark, and errors on a missing named one', () => {
    const missing = path.join(tmpDir(), 'none.jsonl');
    expect(readStore(missing, false)).toEqual({
      runs: [],
      dark: `no history store at ${missing}`,
    });
    expect(() => readStore(missing, true)).toThrow(
      `history store not found: ${missing}`,
    );
    expect(DEFAULT_HISTORY).toBe('test-results/reports/history-v2.jsonl');
  });

  it('rejects malformed lines with their line number', () => {
    expect(() => loadRuns(writeStore(['{}', '{bad']))).toThrow(
      /malformed history record at line 2/,
    );
    expect(() => loadRuns(writeStore(['[1]']))).toThrow(/not an object/);
    expect(() => loadRuns(writeStore(['{"schema_version": 9}']))).toThrow(
      /unsupported schema_version 9/,
    );
    expect(() => loadRuns(writeStore(['{"tests": 3}']))).toThrow(
      /tests is not an array/,
    );
  });
});
