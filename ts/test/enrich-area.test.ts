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
});
