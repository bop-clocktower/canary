/**
 * Contract tests for `scripts/test-duration-ratchet.mjs` (#760).
 *
 * #760 raised `testTimeout` to 30s in both vitest projects so contended tests
 * stop being reported as failures. Nothing in either suite runs over ~3.1s
 * idle, so that is a ~10x detection gap in which a real slowdown is invisible,
 * and the issue asks for the raise to be PAIRED with a recorded expected
 * duration. This is the gate that does the pairing.
 *
 * The whole difficulty is that the quantity being measured is the quantity
 * #760 is about. A naive duration assertion is flaky for exactly the reason
 * the timeouts were, and a gate that fails intermittently teaches people to
 * re-run until green — which is how a real failure gets waved through. So the
 * cases that matter here are not "does it detect a slow test"; they are:
 *
 *   1. It does NOT fire on a genuinely contended run (no false red).
 *   2. It DOES fire on a regression that happens during one (no false green).
 *   3. It abstains rather than guessing when its control group is too small.
 *
 * The mechanism is that each run derives its own load factor from the tracked
 * tests themselves. Contention lifts all of them together, so the ceiling
 * rises with the noise; a regression lifts one, which a median over dozens
 * barely moves.
 *
 * Offline: pure functions over synthetic report objects. Nothing spawns, reads
 * a real report, or touches the committed baseline.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

interface Tracked {
  key: string;
  recorded: number;
  actual: number;
  ratio: number;
  ceiling: number;
}
interface Comparison {
  regressions: Tracked[];
  missing: string[];
  checked: number;
  load: number;
}
interface Baseline {
  nodeVersion: string;
  tests: Record<string, number>;
}
interface RatchetModule {
  FLOOR_MS: number;
  TOLERANCE: number;
  MIN_CONTROL_GROUP: number;
  MAX_LOAD_FACTOR: number;
  median: (values: number[]) => number;
  loadFactor: (ratios: number[]) => number;
  testKey: (file: string, title: string) => string;
  collectDurations: (reports: unknown[]) => Map<string, number>;
  compare: (baseline: Baseline, observed: Map<string, number>) => Comparison;
  buildBaseline: (observed: Map<string, number>) => Baseline & {
    floorMs: number;
  };
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const {
  FLOOR_MS,
  TOLERANCE,
  MIN_CONTROL_GROUP,
  MAX_LOAD_FACTOR,
  median,
  loadFactor,
  testKey,
  collectDurations,
  compare,
  buildBaseline,
} = (await import(
  pathToFileURL(join(REPO_ROOT, 'scripts', 'test-duration-ratchet.mjs')).href
)) as RatchetModule;

/** A baseline of `n` tests all recorded at `ms`. */
function baselineOf(n: number, ms = 1000): Baseline {
  const tests: Record<string, number> = {};
  for (let i = 0; i < n; i++) tests[`f.test.ts::t${i}`] = ms;
  return { nodeVersion: process.version, tests };
}

/** Observations for `baselineOf`, every test scaled by `factor`. */
function observedAt(base: Baseline, factor: number): Map<string, number> {
  return new Map(Object.entries(base.tests).map(([k, v]) => [k, v * factor]));
}

describe('load factor — the control group', () => {
  it('reads an idle run as no load at all', () => {
    expect(loadFactor([1, 1, 1, 1, 1])).toBe(1);
  });

  it('is barely moved by one outlier among many', () => {
    // The asymmetry the whole design rests on: a regression is one test, and a
    // median over dozens does not follow it.
    const ratios = [...Array(50).fill(1), 40];
    expect(loadFactor(ratios)).toBe(1);
  });

  it('tracks a uniform slowdown, which is what contention looks like', () => {
    expect(loadFactor(Array(50).fill(1.4))).toBeCloseTo(1.4);
  });

  it('treats an empty control group as no information, not as no load', () => {
    // Guarded separately by the MIN_CONTROL_GROUP abstention; this just keeps
    // the function total.
    expect(loadFactor([])).toBe(1);
  });
});

describe('compare — no false red', () => {
  it('passes a contended run where every test is uniformly slower', () => {
    // The case that makes a naive gate flaky. Measured on this repo: a loaded
    // run had median ratio 1.38 and a worst case of 2.60, which would have
    // tripped a fixed 2.5x ceiling.
    const base = baselineOf(20);
    const result = compare(base, observedAt(base, 2.4));
    expect(result.regressions).toEqual([]);
    expect(result.load).toBeCloseTo(2.4);
  });

  it('raises the ceiling with the load rather than holding it fixed', () => {
    const base = baselineOf(20);
    const observed = observedAt(base, 2);
    // One test at 4x recorded — but only 2x the run's own load level.
    observed.set('f.test.ts::t0', 4000);
    expect(compare(base, observed).regressions).toEqual([]);
  });
});

describe('compare — no false green', () => {
  it('catches a regression on an idle run', () => {
    const base = baselineOf(20);
    const observed = observedAt(base, 1);
    observed.set('f.test.ts::t0', 1000 * (TOLERANCE + 1));
    const result = compare(base, observed);
    expect(result.regressions.map((r) => r.key)).toEqual(['f.test.ts::t0']);
  });

  it('still catches a regression that happens DURING a contended run', () => {
    // The case a load-tolerant gate most easily loses. Verified end to end on
    // real reports: 5.3x against a load-scaled ceiling of 3.52x still fires.
    const base = baselineOf(20);
    const observed = observedAt(base, 1.4);
    observed.set('f.test.ts::t0', 1000 * 6);
    const result = compare(base, observed);
    expect(result.regressions.map((r) => r.key)).toEqual(['f.test.ts::t0']);
    expect(result.load).toBeCloseTo(1.4);
  });

  it('reports the ceiling it actually applied, not the nominal tolerance', () => {
    const base = baselineOf(20);
    const observed = observedAt(base, 1.4);
    observed.set('f.test.ts::t0', 1000 * 6);
    const [first] = compare(base, observed).regressions;
    expect(first?.ceiling).toBeCloseTo(1000 * 1.4 * TOLERANCE);
  });
});

describe('compare — abstentions', () => {
  it('refuses a baseline that tracks nothing', () => {
    // Zero tracked tests means every comparison passes vacuously.
    expect(() =>
      compare({ nodeVersion: process.version, tests: {} }, new Map()),
    ).toThrow(/zero tests/);
  });

  it('refuses a control group too small to trust its own median', () => {
    const base = baselineOf(MIN_CONTROL_GROUP + 5);
    const observed = new Map(
      Object.entries(base.tests).slice(0, MIN_CONTROL_GROUP - 1),
    );
    expect(() => compare(base, observed)).toThrow(/control group/);
  });

  it('accepts a control group exactly at the floor', () => {
    // Guard the guard: an off-by-one here would abstain forever and the gate
    // would be a permanent no-op that reports success.
    const base = baselineOf(MIN_CONTROL_GROUP);
    expect(compare(base, observedAt(base, 1)).checked).toBe(MIN_CONTROL_GROUP);
  });

  it('refuses a run so contended that normalisation is guesswork', () => {
    const base = baselineOf(20);
    expect(() => compare(base, observedAt(base, MAX_LOAD_FACTOR + 1))).toThrow(
      /too contended/,
    );
  });

  it('reports a tracked test that did not run as unverified, not as passing', () => {
    // "Cannot verify" is a finding: it means the gate covered less than it
    // claims, and nothing else would say so.
    const base = baselineOf(20);
    const observed = observedAt(base, 1);
    observed.delete('f.test.ts::t7');
    const result = compare(base, observed);
    expect(result.missing).toEqual(['f.test.ts::t7']);
    expect(result.checked).toBe(19);
  });
});

describe('collection and baseline', () => {
  const report = (durations: [string, number][]) => ({
    testResults: [
      {
        name: '/repo/agents/skills/test/a.test.ts',
        assertionResults: durations.map(([title, duration]) => ({
          title,
          duration,
        })),
      },
    ],
  });

  it('keys a test by file and title so the baseline reads in a diff', () => {
    expect(testKey('/repo/agents/skills/test/a.test.ts', 'does a thing')).toBe(
      'test/a.test.ts::does a thing',
    );
  });

  it('keeps the WORST duration across runs, never the best', () => {
    // Taking the minimum would let a regression hide behind one lucky run.
    const observed = collectDurations([
      report([['slow', 100]]),
      report([['slow', 900]]),
    ]);
    expect(observed.get('test/a.test.ts::slow')).toBe(900);
  });

  it('tracks only tests above the floor, where timings mean something', () => {
    const built = buildBaseline(
      collectDurations([
        report([
          ['fast', FLOOR_MS - 1],
          ['slow', FLOOR_MS + 1],
        ]),
      ]),
    );
    expect(Object.keys(built.tests)).toEqual(['test/a.test.ts::slow']);
  });

  it('stamps the runtime it was measured on', () => {
    // Durations are not comparable across node versions; the stamp is what
    // lets the gate abstain instead of comparing two instruments.
    expect(buildBaseline(new Map()).nodeVersion).toBe(process.version);
  });

  it('median is the middle value, not the mean', () => {
    expect(median([1, 2, 100])).toBe(2);
  });
});
