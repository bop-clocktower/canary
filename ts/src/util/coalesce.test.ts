import { describe, expect, it } from 'vitest';

import { def } from './coalesce.js';

describe('def', () => {
  it('returns the value when present', () => {
    expect(def('x', 'fallback')).toBe('x');
    expect(def(0, 9)).toBe(0);
    expect(def(false, true)).toBe(false);
  });

  it('returns the fallback for null and undefined', () => {
    expect(def(null, 'fallback')).toBe('fallback');
    expect(def(undefined, 7)).toBe(7);
  });
});
