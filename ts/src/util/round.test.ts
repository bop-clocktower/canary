import { describe, expect, it } from 'vitest';

import { num1, pyFloat, round1 } from './round.js';

describe('round1 half-to-even ties', () => {
  it('rounds an even-floor tie down', () => {
    // 0.25 → 2.5, floor 2 (even) → 2 → 0.2
    expect(round1(0.25)).toBe(0.2);
  });
  it('rounds an odd-floor tie up', () => {
    // 0.75 → 7.5, floor 7 (odd) → 8 → 0.8
    expect(round1(0.75)).toBe(0.8);
  });
  it('rounds non-ties normally', () => {
    expect(round1(12.34)).toBe(12.3);
    expect(round1(12.36)).toBe(12.4);
  });
});

describe('num1', () => {
  it('always renders one decimal', () => {
    expect(num1(50)).toBe('50.0');
    expect(num1(33.34)).toBe('33.3');
  });
});

describe('pyFloat (Python str(float) parity)', () => {
  it('keeps a trailing .0 for integer-valued floats', () => {
    expect(pyFloat(10)).toBe('10.0');
    expect(pyFloat(20)).toBe('20.0');
  });
  it('renders non-integers naturally', () => {
    expect(pyFloat(15.5)).toBe('15.5');
    expect(pyFloat(12.25)).toBe('12.25');
  });
});
