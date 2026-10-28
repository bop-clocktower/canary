/**
 * #1506: ci-ready's flakiness window is per suite, newest first by timestamp.
 *
 * It used to be "the file's last 30 lines". A history that concatenates
 * per-suite files (19 suite-a runs, then 20 suite-b runs) kept only the tail of
 * suite-a, so suite-a's flakes were scored over the wrong denominator or cut
 * out of the window entirely, and the reason's "across 30 run(s)" read as 30
 * runs of every test.
 *
 * Pinned here:
 *   - each suite gets its own last-N window, so the suite-a flake scores 1/19
 *   - the result is independent of file order (timestamps decide)
 *   - a test is scored only over its own suite's runs
 *   - a single-suite history renders byte-for-byte as before (control)
 */
import { describe, expect, it } from 'vitest';

import { scoreCiReady, type CiCheck } from '../src/core/ci-ready.js';
import {
  parseCriticalAreas,
  parseInventory,
} from '../src/core/inventory-checks.js';

interface Run {
  suite: string;
  timestamp: string;
  reporter_format: string;
  tests: { test_name: string; status: string }[];
}

/** Day `n` of an arbitrary month, as the ISO timestamp `history record` writes. */
function day(n: number): string {
  return new Date(Date.UTC(2026, 9, 1) + n * 3_600_000).toISOString();
}

/** `count` runs of one suite; `flakyAt` holds the 0-based oldest-first indexes. */
function suiteRuns(
  suite: string,
  count: number,
  testName: string,
  flakyAt: number[] = [],
): Run[] {
  return Array.from({ length: count }, (_, i) => ({
    suite,
    timestamp: day(i),
    reporter_format: 'playwright',
    tests: [
      { test_name: testName, status: flakyAt.includes(i) ? 'flaky' : 'passed' },
    ],
  }));
}

function flakiness(runs: Run[]): CiCheck {
  const report = scoreCiReady({
    runs,
    historyPath: 'history-v2.jsonl',
    inventory: parseInventory(null),
    criticalAreas: parseCriticalAreas(null),
  });
  return report.checks.find((c) => c.name === 'flakiness')!;
}

/** A deterministic, order-scrambling permutation (no Math.random in tests). */
function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  let seed = 1506;
  for (let i = out.length - 1; i > 0; i--) {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** The issue's fixture: suite-a (flake in its 3rd-oldest run), then suite-b. */
const MULTI = [
  ...suiteRuns('suite-a', 19, 'a-check', [2]),
  ...suiteRuns('suite-b', 20, 'b-check'),
];

describe('ci-ready flakiness window per suite (#1506)', () => {
  it('scores a suite-a flake over suite-a runs: 1/19, not cut by suite-b', () => {
    const f = flakiness(MULTI);
    expect(f.measure).toEqual({
      value: 1 / 19,
      unit: 'ratio',
      denominator: 19,
    });
    expect(f.verdict).toBe('warn');
    expect(f.reason).toContain('suite-a: 19 run(s), suite-b: 20 run(s)');
    expect(f.reason).toContain('worst is a-check in suite-a at 5%');
  });

  it('scores the same records identically in any file order', () => {
    expect(flakiness(shuffle(MULTI))).toEqual(flakiness(MULTI));
    expect(flakiness([...MULTI].reverse())).toEqual(flakiness(MULTI));
  });

  it('keeps each suite to its own newest 30 runs', () => {
    // 35 suite-a runs, the flake in the oldest: it ages out of suite-a's window
    // even though suite-b's runs come after it in the file.
    const runs = [
      ...suiteRuns('suite-a', 35, 'a-check', [0]),
      ...suiteRuns('suite-b', 12, 'b-check'),
    ];
    const f = flakiness(runs);
    expect(f.verdict).toBe('pass');
    expect(f.reason).toContain('suite-a: 30 run(s), suite-b: 12 run(s)');
  });

  it('scores a same-named test only over the runs of its own suite', () => {
    const runs = [
      ...suiteRuns('suite-a', 19, 'shared', [2]),
      ...suiteRuns('suite-b', 20, 'shared'),
    ];
    const f = flakiness(runs);
    expect(f.measure).toEqual({
      value: 1 / 19,
      unit: 'ratio',
      denominator: 19,
    });
    expect(f.reason).toContain('worst is shared in suite-a');
  });

  it('does not pass a clean multi-suite window when one suite is too thin', () => {
    const runs = [
      ...suiteRuns('suite-a', 20, 'a-check'),
      ...suiteRuns('suite-b', 4, 'b-check'),
    ];
    const f = flakiness(runs);
    expect(f.verdict).toBe('warn');
    expect(f.measure).toBeNull();
    expect(f.reason).toContain('suite-b: insufficient history: 4 of 10 runs');
  });

  describe('single-suite control: output is unchanged', () => {
    it('flaky window', () => {
      expect(flakiness(suiteRuns('api', 20, 'login', [3, 9, 15]))).toEqual({
        name: 'flakiness',
        verdict: 'fail',
        reason:
          '1 flaky or alternating test(s) across 20 run(s) (window 30); ' +
          'worst is login at 15% on retry-flake',
        measure: { value: 0.15, unit: 'ratio', denominator: 20 },
      });
    });

    it('clean window longer than 30 runs', () => {
      expect(flakiness(suiteRuns('api', 35, 'login'))).toEqual({
        name: 'flakiness',
        verdict: 'pass',
        reason: '0 flaky or alternating tests across 30 run(s) (window 30)',
        measure: { value: 0, unit: 'ratio', denominator: 30 },
      });
    });

    it('thin window', () => {
      expect(flakiness(suiteRuns('api', 5, 'login'))).toEqual({
        name: 'flakiness',
        verdict: 'warn',
        reason:
          'insufficient history: 5 of 10 runs (window 30) \u{2014} no flake verdict',
        measure: null,
      });
    });
  });
});
