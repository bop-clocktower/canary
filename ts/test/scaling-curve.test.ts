/**
 * Scaling-curve probe (#856): fit how cost grows with input size, and abstain
 * when the data cannot support a verdict. "Linear" off three noisy samples is a
 * false green, so every abstention rule has a case of its own.
 */

import { describe, expect, it } from 'vitest';

import { fitScaling, parsePoints } from '../src/core/scaling-curve.js';

const LADDER = [1000, 2000, 4000, 8000, 16000];
const curve = (f: (n: number) => number) =>
  LADDER.map((size) => ({ size, value: f(size) }));

describe('fitScaling', () => {
  it('classifies quadratic growth as strongly superlinear with b ≈ 2', () => {
    const r = fitScaling(curve((n) => 1e-4 * n * n));
    expect(r.verdict).toBe('STRONGLY_SUPERLINEAR');
    if (r.verdict === 'INSUFFICIENT_DATA') throw new Error('unreachable');
    expect(r.exponent).toBeCloseTo(2, 2);
    expect(r.r2).toBeGreaterThan(0.99);
  });

  // n log n over a 16x ladder fits b ≈ 1.12 -- honestly near-linear -- so the
  // superlinear band is pinned with n^1.4 instead.
  it('classifies n^1.4 as superlinear, and linear as linear-or-better', () => {
    expect(fitScaling(curve((n) => n ** 1.4)).verdict).toBe('SUPERLINEAR');
    expect(fitScaling(curve((n) => 3 * n)).verdict).toBe('LINEAR_OR_BETTER');
  });

  it('reports the knee where a linear curve bends', () => {
    const r = fitScaling(curve((n) => (n <= 4000 ? n : (n * n) / 4000)));
    if (r.verdict === 'INSUFFICIENT_DATA') throw new Error(r.reasons.join());
    expect(r.knee).toBe(4000);
    const linear = fitScaling(curve((n) => 3 * n));
    expect('knee' in linear && linear.knee).toBeNull();
  });

  it('uses the median of repeated samples at a size', () => {
    const points = [
      ...curve((n) => n),
      { size: 1000, value: 1010 },
      { size: 1000, value: 990 },
    ];
    const r = fitScaling(points);
    if (r.verdict === 'INSUFFICIENT_DATA') throw new Error(r.reasons.join());
    expect(r.points[0]).toEqual({ size: 1000, value: 1000, samples: 3 });
  });

  it('extrapolates to a target size, labelled with its multiple', () => {
    const r = fitScaling(
      curve((n) => 1e-4 * n * n),
      { target: 160000 },
    );
    if (r.verdict === 'INSUFFICIENT_DATA') throw new Error(r.reasons.join());
    expect(r.extrapolation?.multipleOfLargest).toBe(10);
    expect(r.extrapolation?.value).toBeCloseTo(1e-4 * 160000 ** 2, -3);
  });

  describe('abstains, naming the rule', () => {
    const abstains = (
      points: { size: number; value: number }[],
      rule: RegExp,
    ) => {
      const r = fitScaling(points);
      if (r.verdict !== 'INSUFFICIENT_DATA') throw new Error(r.verdict);
      expect(r.reasons.join('\n')).toMatch(rule);
    };

    it('on fewer than 4 distinct sizes', () =>
      abstains(curve((n) => n).slice(0, 3), /4 distinct sizes/));

    it('on a size span under 8x', () =>
      abstains(
        [1000, 1500, 2000, 3000].map((size) => ({ size, value: size })),
        /span/,
      ));

    it('on a noisy size', () =>
      abstains(
        [
          ...curve((n) => n),
          { size: 2000, value: 500 },
          { size: 2000, value: 4000 },
        ],
        /noisy/,
      ));

    it('on a poor fit', () =>
      abstains(
        LADDER.map((size, i) => ({ size, value: i % 2 ? 1 : 1000 })),
        /R²/,
      ));

    it('on a non-positive or non-finite value', () =>
      abstains([...curve((n) => n), { size: 3000, value: 0 }], /positive/));
  });
});

describe('parsePoints', () => {
  it('reads the JSON shape', () => {
    const p = parsePoints(
      JSON.stringify({ metric: 'p95_ms', points: [{ size: 1, value: 2 }] }),
    );
    expect(p).toEqual({ metric: 'p95_ms', points: [{ size: 1, value: 2 }] });
  });

  it('reads size,value CSV', () => {
    expect(parsePoints('size,value\n1,2\n4,8\n').points).toEqual([
      { size: 1, value: 2 },
      { size: 4, value: 8 },
    ]);
  });

  it('rejects input it cannot read rather than returning no points', () => {
    expect(() => parsePoints('nonsense')).toThrow(/size,value/);
  });
});
