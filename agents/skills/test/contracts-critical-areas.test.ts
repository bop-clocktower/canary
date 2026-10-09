/**
 * The critical-areas.json contract (#1242): the file canary-critical-areas
 * writes and canary-katana alarms on. `symbols` is optional, so every file
 * written before it existed stays valid; when present it is checked, because a
 * bad list would otherwise make katana match on something nobody meant.
 */
import { describe, it, expect } from 'vitest';

import {
  normSymbol,
  validateCriticalAreas,
} from '../lib/contracts/critical-areas.mjs';

const paths = (doc: unknown) =>
  validateCriticalAreas(doc).errors.map((e: { path: string }) => e.path);

describe('critical-areas contract', () => {
  it('accepts a file written before symbols existed (backward compatible)', () => {
    const doc = {
      generated: '2026-07-20T00:00:00+00:00',
      areas: [{ path: 'src/loyalty/points.service.ts', risk_score: 0.92 }],
    };
    expect(validateCriticalAreas(doc)).toEqual({
      valid: true,
      checked: 1,
      errors: [],
    });
  });

  it('accepts declared symbols', () => {
    const doc = {
      areas: [
        {
          path: 'src/engine.ts',
          risk_score: 0.9,
          symbols: ['pricingEngine', 'quoteTotal'],
        },
      ],
    };
    expect(validateCriticalAreas(doc).valid).toBe(true);
  });

  it.each([
    ['not an array', 'pricingEngine', ['areas[0].symbols']],
    ['a non-string item', ['ok', 7], ['areas[0].symbols[1]']],
    ['a blank item', ['ok', '  '], ['areas[0].symbols[1]']],
    ['an empty list', [], ['areas[0].symbols']],
    ['a punctuation-only item', ['--'], ['areas[0].symbols[0]']],
  ])('refuses symbols that are %s', (_, symbols, expected) => {
    expect(paths({ areas: [{ path: 'src/engine.ts', symbols }] })).toEqual(
      expected,
    );
  });

  it('refuses an area without a path, or with a non-numeric risk_score', () => {
    expect(paths({ areas: [{ risk_score: 0.9 }] })).toEqual(['areas[0].path']);
    expect(paths({ areas: [{ path: 'a.ts', risk_score: '0.9' }] })).toEqual([
      'areas[0].risk_score',
    ]);
  });

  it('refuses a document without an areas list', () => {
    expect(paths({})).toEqual(['areas']);
    expect(paths([])).toEqual(['$']);
  });

  it('counts the areas it read as its denominator', () => {
    expect(validateCriticalAreas({ areas: [] }).checked).toBe(0);
    expect(
      validateCriticalAreas({ areas: [{ path: 'a.ts' }, { path: 'b.ts' }] })
        .checked,
    ).toBe(2);
  });

  it('normalizes a symbol the way katana compares titles', () => {
    expect(normSymbol('pricing-Engine_v2')).toBe('pricingenginev2');
  });
});
