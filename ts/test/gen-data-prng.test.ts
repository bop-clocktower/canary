import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SEED,
  mulberry32,
  parseSeed,
} from '../src/core/gen-data/prng.js';

describe('mulberry32', () => {
  it('is a pure function of the seed', () => {
    const a = mulberry32(765),
      b = mulberry32(765);
    const seqA = [a(), a(), a()],
      seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
    expect(seqA.every((x) => x >= 0 && x < 1)).toBe(true);
  });
  it('differs across seeds', () => {
    expect(mulberry32(765)()).not.toBe(mulberry32(766)());
  });
});

describe('parseSeed', () => {
  it('defaults to the fixed constant 765, never a clock', () => {
    expect(DEFAULT_SEED).toBe(765);
    expect(parseSeed(undefined)).toEqual({ ok: true, seed: 765 });
  });
  it.each(['12', '0', '-3'])('accepts integer %s', (v) => {
    expect(parseSeed(v)).toEqual({ ok: true, seed: Number(v) });
  });
  it.each(['1.5', 'abc', '', '9007199254740993'])('rejects %j', (v) => {
    expect(parseSeed(v).ok).toBe(false);
  });
});
