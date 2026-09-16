import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/core/gen-data/prng.js';
import { defaultValue, leafCases } from '../src/core/gen-data/strategies.js';

describe('leafCases', () => {
  it('boundary for a non-integer number includes a fractional value (SOUND-003)', () => {
    const cases = leafCases(
      { kind: 'number', integer: false, min: 0, max: 100 },
      'total',
    );
    const boundary = cases
      .filter((c) => c.category === 'boundary')
      .map((c) => c.value);
    expect(boundary).toEqual(
      expect.arrayContaining([
        0,
        -1,
        1,
        Number.MAX_SAFE_INTEGER,
        Number.MIN_SAFE_INTEGER,
        101,
      ]),
    );
    expect(
      boundary.some((v) => typeof v === 'number' && !Number.isInteger(v)),
    ).toBe(true);
  });
  it('an integer field gets no fractional boundary', () => {
    const cases = leafCases({ kind: 'number', integer: true }, 'qty');
    expect(
      cases.every(
        (c) => typeof c.value !== 'number' || Number.isInteger(c.value),
      ),
    ).toBe(true);
  });
  it('strings get empty, whitespace, maxLength+1 and non-ASCII/RTL/emoji literals', () => {
    const values = leafCases({ kind: 'string', maxLength: 3 }, 'code').map(
      (c) => c.value,
    );
    expect(values).toEqual(expect.arrayContaining(['', '   ', 'xxxx']));
    expect(values.some((v) => typeof v === 'string' && /[֐-׿]/.test(v))).toBe(
      true,
    );
  });
  it('dates are fixed ISO-8601 UTC literals with an explicit Z, incl. leap-day', () => {
    const values = leafCases({ kind: 'date' }, 'placedAt').map((c) => c.value);
    expect(values).toContain('2024-02-29T23:59:59Z');
    expect(
      values
        .filter((v) => typeof v === 'string')
        .every((v) => String(v).endsWith('Z') || !/^\d{4}-/.test(String(v))),
    ).toBe(true);
  });
  it('unexpected-shape offers wrong primitive type and null', () => {
    const cats = leafCases({ kind: 'string' }, 'id').filter(
      (c) => c.category === 'unexpected-shape',
    );
    expect(cats.map((c) => c.value)).toEqual(expect.arrayContaining([null, 0]));
  });
});

describe('defaultValue', () => {
  it('is seed-dependent for strings and non-boundary numbers', () => {
    const s = { kind: 'string' } as const;
    expect(defaultValue(s, 'id', mulberry32(765))).not.toBe(
      defaultValue(s, 'id', mulberry32(1)),
    );
  });
  it('respects min/max and integer-ness', () => {
    const v = defaultValue(
      { kind: 'number', integer: true, min: 1, max: 99 },
      'qty',
      mulberry32(765),
    );
    expect(Number.isInteger(v)).toBe(true);
    expect(v as number).toBeGreaterThanOrEqual(1);
    expect(v as number).toBeLessThanOrEqual(99);
  });
});
