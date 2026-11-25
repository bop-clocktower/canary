/**
 * canary-cry abuse-pattern catalog (#608 P1). The catalog is data the matrix
 * reads, so its shape is the contract: six patterns, the whisper core set,
 * one description per intensity up to the ceiling, and nothing mutable.
 */
import { describe, expect, it } from 'vitest';

import {
  INTENSITY_CEILING,
  PATTERNS,
} from '../claude-code/canary-cry/scripts/patterns.mjs';

const ANCHORS = [
  'write',
  'write-not-last',
  'await-response',
  'first-write',
  'last-step',
];

describe('abuse-pattern catalog', () => {
  it('lists the six spec patterns in catalog order', () => {
    expect(PATTERNS.map((p) => p.id)).toEqual([
      'multi-submit',
      'abandon-midflow',
      'stale-optimistic',
      'duplicate-tab',
      'token-expiry',
      'shared-machine',
    ]);
  });

  it('marks exactly multi-submit and abandon-midflow as the whisper core', () => {
    expect(PATTERNS.filter((p) => p.core).map((p) => p.id)).toEqual([
      'multi-submit',
      'abandon-midflow',
    ]);
  });

  it('scopes only token-expiry and shared-machine to a target', () => {
    expect(
      PATTERNS.filter((p) => p.requires !== null).map((p) => [
        p.id,
        p.requires,
      ]),
    ).toEqual([
      ['token-expiry', 'session-keys'],
      ['shared-machine', 'two-accounts'],
    ]);
  });

  it('gives each pattern a weight, a known anchor and one line per intensity', () => {
    expect(INTENSITY_CEILING).toBe(3);
    for (const p of PATTERNS) {
      expect(Number.isInteger(p.weight) && p.weight > 0, p.id).toBe(true);
      expect(ANCHORS, p.id).toContain(p.anchor);
      expect(p.intensities, p.id).toHaveLength(INTENSITY_CEILING);
    }
  });

  it('is frozen all the way down, so no caller can re-rank the catalog', () => {
    expect(Object.isFrozen(PATTERNS)).toBe(true);
    for (const p of PATTERNS) {
      expect(Object.isFrozen(p), p.id).toBe(true);
      expect(Object.isFrozen(p.intensities), p.id).toBe(true);
    }
  });
});
