/** D8 of #1125: test file -> critical-area path by file stem. */
import { describe, expect, it } from 'vitest';

import { areaFor } from '../src/analysis/enrich/area.js';

const area = (path: string, risk_score = 1) => ({ path, risk_score });

describe('areaFor', () => {
  it('maps a .spec file to the area with the same stem', () => {
    expect(areaFor('checkout.spec.ts', [area('src/checkout.ts')])).toBe(
      'src/checkout.ts',
    );
  });

  it('strips a .test marker as well as the extension', () => {
    expect(areaFor('test/cart.test.ts', [area('src/cart.tsx')])).toBe(
      'src/cart.tsx',
    );
  });

  it('returns undefined when no area shares the stem', () => {
    expect(areaFor('checkout-flow.spec.ts', [area('src/checkout.ts')])).toBe(
      undefined,
    );
    expect(areaFor('checkout.spec.ts', [])).toBe(undefined);
  });

  it('prefers the candidate sharing more trailing directory segments', () => {
    const areas = [
      area('src/cart/checkout.ts', 9),
      area('src/billing/checkout.ts', 1),
    ];
    expect(areaFor('e2e/billing/checkout.spec.ts', areas)).toBe(
      'src/billing/checkout.ts',
    );
  });

  it('breaks a directory tie by risk_score, then by path', () => {
    expect(
      areaFor('checkout.spec.ts', [
        area('a/checkout.ts', 1),
        area('b/checkout.ts', 5),
      ]),
    ).toBe('b/checkout.ts');
    expect(
      areaFor('checkout.spec.ts', [
        area('b/checkout.ts', 2),
        area('a/checkout.ts', 2),
      ]),
    ).toBe('a/checkout.ts');
  });

  it('maps other test-file shapes: .spec.tsx, .test.js, absolute paths', () => {
    expect(areaFor('ui/Cart.spec.tsx', [area('src/Cart.tsx')])).toBe(
      'src/Cart.tsx',
    );
    expect(areaFor('cart.test.js', [area('src/cart.ts')])).toBe('src/cart.ts');
    expect(
      areaFor('/home/ci/repo/e2e/cart.spec.ts', [area('src/cart.ts')]),
    ).toBe('src/cart.ts');
  });

  it('normalises Windows separators on both sides', () => {
    expect(
      areaFor('C:\\repo\\e2e\\billing\\checkout.spec.ts', [
        area('src/cart/checkout.ts', 9),
        area('src\\billing\\checkout.ts', 1),
      ]),
    ).toBe('src\\billing\\checkout.ts');
  });

  it('never maps an empty test file or an area with no file stem', () => {
    expect(areaFor('', [area('src/payments/')])).toBe(undefined);
    expect(areaFor('', [area('')])).toBe(undefined);
    expect(areaFor('e2e/.spec.ts', [area('src/payments/')])).toBe(undefined);
  });

  it('ranks a non-numeric risk_score as 0, whatever the input order', () => {
    const odd = area('b/x.ts', Number.NaN);
    const low = area('a/x.ts', 0);
    expect(areaFor('x.spec.ts', [odd, low])).toBe('a/x.ts');
    expect(areaFor('x.spec.ts', [low, odd])).toBe('a/x.ts');
  });
});
