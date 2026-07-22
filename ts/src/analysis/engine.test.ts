import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AnalysisEngine } from './engine.js';
import type { HistoryStore } from '../history/ndjson-store.js';
import { NdjsonHistoryStore } from '../history/ndjson-store.js';

let dir: string;

function seed(): NdjsonHistoryStore {
  const records = [
    {
      run_id: 'r1',
      suite: 'checkout',
      timestamp: '2026-07-01T00:00:00Z',
      passed: 1,
      failed: 1,
      flaky: 0,
      total: 2,
      commit_sha: 'aaa',
      tests: [
        { test_name: 'test_ok', status: 'passed' },
        {
          test_name: 'test_pay',
          status: 'failed',
          failure_category: 'assertion',
          error_text: 'AssertionError: expected 200',
        },
      ],
    },
    {
      run_id: 'r2',
      suite: 'checkout',
      timestamp: '2026-07-02T00:00:00Z',
      passed: 1,
      failed: 1,
      flaky: 0,
      total: 2,
      commit_sha: 'bbb',
      tests: [
        { test_name: 'test_ok', status: 'passed' },
        {
          test_name: 'test_pay',
          status: 'failed',
          failure_category: 'assertion',
          error_text: 'AssertionError: expected 200',
        },
      ],
    },
  ];
  const path = join(dir, 'history-v2.jsonl');
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return new NdjsonHistoryStore(path);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canary-engine-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('AnalysisEngine over the NDJSON store', () => {
  it('produces all six artifacts', () => {
    const result = new AnalysisEngine(seed()).run({ window: 10 });
    expect(Object.keys(result.artifacts).sort()).toEqual([
      'area-health.md',
      'common-failures.md',
      'digest.md',
      'flaky.md',
      'regression-candidates.md',
      'spikes.md',
    ]);
  });

  it('discovers seeded suites', () => {
    expect(new AnalysisEngine(seed()).discoverSuites()).toContain('checkout');
  });

  it('tags pooled spike rows with their suite', () => {
    const result = new AnalysisEngine(seed()).run({ window: 10 });
    expect(result.spikes.length).toBeGreaterThan(0);
    expect(result.spikes.every((row) => 'suite' in row)).toBe(true);
  });

  it('extracts common failures from failed tests', () => {
    const rows = new AnalysisEngine(seed()).queryCommonFailures(null);
    expect(rows.some((r) => r.test_name === 'test_pay')).toBe(true);
  });

  it('respects the suite filter for common failures', () => {
    expect(new AnalysisEngine(seed()).queryCommonFailures('nope')).toEqual([]);
  });

  it('area-health is always the empty-data message (faithful to Python)', () => {
    const result = new AnalysisEngine(seed()).run({ window: 10 });
    expect(result.artifacts['area-health.md']).toContain('No area health');
    expect(result.areaHealth).toEqual([]);
  });

  it('surfaces a regression candidate after a green streak then failures', () => {
    // 5 green runs then 3 failing runs → regression candidate.
    const records = [
      ...Array.from({ length: 5 }, (_, i) => ({
        run_id: `g${i}`,
        suite: 'checkout',
        timestamp: `2026-07-0${i + 1}T00:00:00Z`,
        passed: 1,
        failed: 0,
        flaky: 0,
        total: 1,
        commit_sha: `green${i}`,
        tests: [{ test_name: 'test_reg', status: 'passed' }],
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        run_id: `f${i}`,
        suite: 'checkout',
        timestamp: `2026-07-1${i}T00:00:00Z`,
        passed: 0,
        failed: 1,
        flaky: 0,
        total: 1,
        commit_sha: `fail${i}`,
        tests: [
          {
            test_name: 'test_reg',
            status: 'failed',
            error_text: 'boom',
          },
        ],
      })),
    ];
    const path = join(dir, 'history-v2.jsonl');
    writeFileSync(
      path,
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
    const result = new AnalysisEngine(new NdjsonHistoryStore(path)).run({
      window: 30,
    });
    expect(result.regressionCandidates.length).toBe(1);
    const [cand] = result.regressionCandidates;
    expect(cand!.test_name).toBe('test_reg');
    expect(cand!.green_streak).toBe(5);
    expect(cand!.first_failure_commit).toBe('fail0');
    expect(result.artifacts['regression-candidates.md']).toContain('test_reg');
  });
});

describe('AnalysisEngine with a non-readable store falls through cleanly', () => {
  const stub: HistoryStore = {
    queryFlaky: () => [],
    querySummary: (suite) => ({ suite, total_runs: 0, avg_pass_rate: 0 }),
    queryTimeline: () => [],
  };

  it('discoverSuites is empty', () => {
    expect(new AnalysisEngine(stub).discoverSuites()).toEqual([]);
  });
  it('queryCommonFailures is empty', () => {
    expect(new AnalysisEngine(stub).queryCommonFailures(null)).toEqual([]);
  });
  it('detectRegressionCandidates is empty', () => {
    expect(
      new AnalysisEngine(stub).detectRegressionCandidates(null, 5, 3),
    ).toEqual([]);
  });
  it('run does not throw', () => {
    expect(() => new AnalysisEngine(stub).run({ window: 5 })).not.toThrow();
  });
});
