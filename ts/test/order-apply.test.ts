/**
 * Applying an order plan to a runner's file list (#460 phase 3): the pure
 * half of the vitest sequencer. Files the plan does not know go last in their
 * original order, and nothing is ever dropped or duplicated.
 */

import { describe, expect, it } from 'vitest';

import { applyOrderPlan, parseOrderPlan } from '../src/analysis/order/apply.js';

const ROOT = '/repo';
const plan = {
  mode: 'history+diff',
  modeReason: 'x',
  historyRuns: 9,
  changedFiles: 1,
  entries: [
    { test_file: 'ts/test/c.test.ts', score: 2, reasons: ['r'] },
    { test_file: 'ts/test/a.test.ts', score: 1, reasons: ['r'] },
    { test_file: 'ts/test/b.test.ts', score: 0, reasons: [] },
  ],
  unranked: ['ts/test/b.test.ts'],
};

const abs = (rel: string): string => `${ROOT}/${rel}`;

describe('applyOrderPlan', () => {
  it('orders absolute module ids by the plan', () => {
    const ids = ['a', 'b', 'c'].map((n) => abs(`ts/test/${n}.test.ts`));
    expect(applyOrderPlan(ids, plan, ROOT)).toEqual([
      abs('ts/test/c.test.ts'),
      abs('ts/test/a.test.ts'),
      abs('ts/test/b.test.ts'),
    ]);
  });

  it('puts files missing from the plan last, in their original order', () => {
    const ids = [
      abs('ts/test/new2.test.ts'),
      abs('ts/test/a.test.ts'),
      abs('ts/test/new1.test.ts'),
      abs('ts/test/c.test.ts'),
    ];
    expect(applyOrderPlan(ids, plan, ROOT)).toEqual([
      abs('ts/test/c.test.ts'),
      abs('ts/test/a.test.ts'),
      abs('ts/test/new2.test.ts'),
      abs('ts/test/new1.test.ts'),
    ]);
  });

  it('never drops or duplicates, whatever the plan holds', () => {
    const ids = [abs('ts/test/a.test.ts'), abs('ts/test/a.test.ts')];
    const out = applyOrderPlan(ids, plan, ROOT);
    expect([...out].sort()).toEqual([...ids].sort());
  });

  it('matches Windows-style ids against POSIX plan paths', () => {
    const out = applyOrderPlan(
      ['C:\\repo\\ts\\test\\a.test.ts', 'C:\\repo\\ts\\test\\c.test.ts'],
      plan,
      'C:\\repo',
    );
    expect(out[0]).toBe('C:\\repo\\ts\\test\\c.test.ts');
  });
});

describe('parseOrderPlan', () => {
  it('accepts a plan with entries', () => {
    expect(parseOrderPlan(JSON.stringify(plan))?.entries).toHaveLength(3);
  });

  it.each(['not json', '{}', '{"entries":"x"}', '{"entries":[{"score":1}]}'])(
    'returns null for %s',
    (text) => {
      expect(parseOrderPlan(text)).toBeNull();
    },
  );
});
