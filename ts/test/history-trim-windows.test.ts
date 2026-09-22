/**
 * #1024: the windows must survive the trim.
 *
 * `fleet-health` now trims its cached store to the newest 50 runs before the
 * Actions cache save, because an unbounded store means an unbounded cache
 * entry. The question that test suite has to answer is not "did it delete
 * rows" -- it is whether the readers can still reach a verdict afterwards.
 *
 * Two consuming windows exist, and a trim that starves either one would turn
 * every downstream report into a silent abstention that still exits 0:
 *
 *   - MIN_WINDOW_RUNS (10) -- below it, the flake verdict abstains by design.
 *   - the 30-run default window of `history flaky` / `canary analyze`.
 *
 * N = 50 was chosen by the human specifically to sit above both. These tests
 * pin that relationship so a later "let's make the cache smaller" cannot cut N
 * under a window without a red test saying so.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NdjsonHistoryStore } from '../src/history/ndjson-store.js';
import { SCHEMA_VERSION } from '../src/history/record.js';
import { MIN_WINDOW_RUNS } from '../src/util/flake-window.js';

/** The value `.github/workflows/dogfood.yml` passes to `history trim --keep`. */
const FLEET_HEALTH_KEEP = 50;
/** The default `--window` of `history flaky` and `canary analyze`. */
const ANALYZE_WINDOW = 30;

let dir: string;
let path: string;

function seedStore(runs: number): NdjsonHistoryStore {
  const lines: string[] = [];
  for (let i = 1; i <= runs; i += 1) {
    lines.push(
      JSON.stringify({
        run_id: `run-${String(i).padStart(3, '0')}`,
        suite: 'ts-engine',
        schema_version: SCHEMA_VERSION,
        // Minutes apart, so ordering is unambiguous and lexicographic ISO
        // comparison (what the store uses) matches numeric order.
        timestamp: `2026-09-21T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`,
        total: 2,
        passed: i % 3 === 0 ? 1 : 2,
        failed: i % 3 === 0 ? 1 : 0,
        flaky: 0,
        tests: [
          { test_name: 'steady test', status: 'passed' },
          {
            test_name: 'wobbly test',
            status: i % 3 === 0 ? 'failed' : 'passed',
          },
        ],
      }),
    );
  }
  writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
  return new NdjsonHistoryStore(path);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canary-trim-window-'));
  path = join(dir, 'history-v2.jsonl');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('#1024: a trimmed store still feeds every read-side window', () => {
  it('keeps N comfortably above both consuming windows', () => {
    // Not a tautology dressed as a test: these three numbers live in three
    // different files (the workflow, flake-window.ts, the analyze CLI default),
    // and the whole safety argument for trimming is this ordering.
    expect(FLEET_HEALTH_KEEP).toBeGreaterThan(ANALYZE_WINDOW);
    expect(FLEET_HEALTH_KEEP).toBeGreaterThan(MIN_WINDOW_RUNS);
  });

  it('still serves the full 30-run analyze window after a trim to 50', () => {
    const store = seedStore(60);
    expect(store.countRuns()).toBe(60);

    const result = store.trimToNewest(FLEET_HEALTH_KEEP);
    expect(result).toEqual({ before: 60, after: 50, removed: 10 });

    // The point of the whole exercise: the 30-run reader is not starved.
    const summary = store.querySummary('ts-engine', ANALYZE_WINDOW);
    expect(summary.total_runs).toBe(ANALYZE_WINDOW);

    // And the 30 runs it reads are the NEWEST 30, not a stale prefix left
    // behind by the trim.
    expect(summary.runs?.map((r) => r.run_id)).toEqual(
      Array.from(
        { length: ANALYZE_WINDOW },
        (_, i) => `run-${String(60 - ANALYZE_WINDOW + i + 1).padStart(3, '0')}`,
      ),
    );
  });

  it('still reaches a flake verdict (denominator >= the minimum) after a trim', () => {
    const store = seedStore(60);
    store.trimToNewest(FLEET_HEALTH_KEEP);

    expect(store.countRuns()).toBeGreaterThanOrEqual(MIN_WINDOW_RUNS);

    const rows = store.queryFlaky(ANALYZE_WINDOW, 'ts-engine', 10);
    const wobbly = rows.find((r) => r.test_name === 'wobbly test');
    // A real finding over a real denominator, not an abstention: the wobbly
    // test fails every third run, so it must still be visible with 30 runs of
    // evidence behind it.
    expect(wobbly).toBeDefined();
    expect(wobbly?.total_runs).toBe(ANALYZE_WINDOW);
  });

  it('a store trimmed at the 50-run steady state holds exactly 50', () => {
    // The steady state in CI: every run appends one and trims back to N, so the
    // store parks at N rather than oscillating.
    const store = seedStore(50);
    expect(store.trimToNewest(FLEET_HEALTH_KEEP).removed).toBe(0);
    expect(store.countRuns()).toBe(FLEET_HEALTH_KEEP);
  });
});
