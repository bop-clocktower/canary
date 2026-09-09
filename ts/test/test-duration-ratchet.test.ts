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

import { readFileSync } from 'node:fs';
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
  SPAWN_SLACK_MS: number;
  MIN_CONTROL_GROUP: number;
  MAX_LOAD_FACTOR: number;
  MIN_LOAD_FACTOR: number;
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
  SPAWN_SLACK_MS,
  MIN_CONTROL_GROUP,
  MAX_LOAD_FACTOR,
  MIN_LOAD_FACTOR,
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

describe('compare — a faster run is never a regression', () => {
  // Found by CI on the first run of this gate, not by these tests, which had
  // only ever exercised load factors at or above 1. A macOS-recorded baseline
  // against an ubuntu runner gave a load factor of 0.08 — Linux spawns roughly
  // an order of magnitude faster and these tests are spawn-bound — so the
  // ceiling became 0.21x recorded and EIGHT tests were reported as regressions
  // for running FASTER than baseline. The normalisation was unbounded
  // downward; it must only ever loosen.
  it('does not tighten the ceiling when the run is faster than the baseline', () => {
    const base = baselineOf(20);
    const observed = observedAt(base, 0.8);
    // 1.5x the recorded time, but well under the nominal tolerance.
    observed.set('f.test.ts::t0', 1500);
    const result = compare(base, observed);
    expect(result.regressions).toEqual([]);
    expect(result.load).toBe(1);
  });

  it('still applies the full tolerance on a faster-than-baseline run', () => {
    const base = baselineOf(20);
    const observed = observedAt(base, 0.8);
    observed.set('f.test.ts::t0', 1000 * (TOLERANCE + 1));
    expect(compare(base, observed).regressions).toHaveLength(1);
  });

  it('abstains when the run is a different class of machine entirely', () => {
    const base = baselineOf(20);
    expect(() => compare(base, observedAt(base, MIN_LOAD_FACTOR / 2))).toThrow(
      /different class of machine/,
    );
  });
});

describe('compare — a contended spawn is below the resolution of the instrument', () => {
  // The second instance of #760, this time surfacing THROUGH the ratchet
  // rather than through the 5000ms timeout: CI run 34327672926 fired on four
  // tests recorded at 80-87ms that measured 425-835ms, and the re-run of the
  // same commit reported 0 regressions at load factor 1.00. The load factor
  // could not have saved them, because the runner's contention is not uniform
  // — half the tracked tests ran FASTER than recorded in the same run while a
  // handful took a 200-755ms penalty each — so the median saw little and the
  // penalty landed on tests whose whole recorded duration is one spawn.
  //
  // A multiplicative ceiling over an 80ms recording asks the runner to spawn
  // a process within 200ms every time, which it does not. The ceiling now
  // carries an absolute slack of one contended spawn: a slowdown smaller than
  // that is noise this instrument cannot distinguish from a regression, and
  // claiming otherwise is the false red that teaches re-run-until-green.
  interface RealRun {
    recorded: Record<string, number>;
    contended: Record<string, number>;
    rerun: Record<string, number>;
  }
  const run = JSON.parse(
    readFileSync(
      join(
        REPO_ROOT,
        'ts',
        'test',
        'fixtures',
        'duration-ratchet-run-34327672926.json',
      ),
      'utf-8',
    ),
  ) as RealRun;
  const baseline: Baseline = {
    nodeVersion: process.version,
    tests: run.recorded,
  };

  it('does not fire on the real contended run that fired in CI', () => {
    const result = compare(baseline, new Map(Object.entries(run.contended)));
    expect(result.regressions.map((r) => r.key)).toEqual([]);
    expect(result.checked).toBe(Object.keys(run.recorded).length);
  });

  it('does not fire on the re-run of the same commit either', () => {
    const result = compare(baseline, new Map(Object.entries(run.rerun)));
    expect(result.regressions).toEqual([]);
  });

  it('still fires when a small test regresses by more than one contended spawn', () => {
    // The slack is a resolution limit, not an exemption: a test recorded at
    // 80ms that now takes seconds is exactly the 30s-window regression the
    // gate exists for.
    const observed = new Map(Object.entries(run.contended));
    const key =
      'test/canary-katana.test.ts::commitForFile returns null for an unknown path';
    observed.set(key, run.recorded[key]! * TOLERANCE + SPAWN_SLACK_MS + 1);
    expect(compare(baseline, observed).regressions.map((r) => r.key)).toEqual([
      key,
    ]);
  });

  it('does not let the slack loosen the multiplicative rule on a large test', () => {
    // The slack is a conjunction, not a wider ceiling. On a test recorded in
    // seconds a 2.5x overrun is already tens of thousands of ms of absolute
    // slowdown, so the second condition is satisfied the moment the first is
    // and the reported ceiling is the multiplicative one, exactly as before.
    // Added instead, this ceiling would have been 27,000ms and this 26,000ms
    // regression would have gone unreported.
    const base = baselineOf(20, 10_000);
    const observed = observedAt(base, 1);
    observed.set('f.test.ts::t0', 10_000 * (TOLERANCE + 0.1));
    const [first] = compare(base, observed).regressions;
    expect(first?.key).toBe('f.test.ts::t0');
    expect(first?.ceiling).toBeCloseTo(10_000 * TOLERANCE);
  });

  it('is sized from the runner, not the laptop, and stays inside the gate’s purpose', () => {
    // 755ms was the largest single-test penalty on the contended run; the
    // slack must cover it with margin, and must stay well under the 30s
    // timeout window the gate exists to watch — a slack that swallowed
    // seconds would recreate the detection gap #760 opened.
    const penalties = Object.keys(run.recorded).map(
      (k) => run.contended[k]! - run.recorded[k]!,
    );
    expect(Math.max(...penalties)).toBeLessThan(SPAWN_SLACK_MS);
    expect(SPAWN_SLACK_MS).toBeLessThanOrEqual(3_000);
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
