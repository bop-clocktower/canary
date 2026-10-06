// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { Register } from '../lib/site-kit/panels/register.js';
import {
  DAY,
  iso,
  live,
  mount,
  NOW,
  registerRow,
  siteFeed,
} from './site-kit-helpers.js';

describe('<canary-register>', () => {
  it('shows each row with kind, reason, age and issue', () => {
    const row = registerRow({ title: 'checkout > pays', issue: '#42' });
    const li = mount(Register, siteFeed({ register: [row] })).querySelector(
      'li',
    )!;
    for (const text of [
      'checkout > pays',
      'test/a.test.ts',
      'skipped',
      'flaky on CI',
      '10 day(s) old',
      '#42',
    ])
      expect(li.textContent).toContain(text);
  });

  it('lists the oldest debt first', () => {
    const register = [
      registerRow({ title: 'young', recorded_at: iso(NOW - DAY) }),
      registerRow({ title: 'old', recorded_at: iso(NOW - 30 * DAY) }),
    ];
    const root = mount(Register, siteFeed({ register }));
    expect(root.querySelector('li strong')!.textContent).toBe('old');
  });

  it('announces that an empty register is ambiguous rather than claiming no debt', () => {
    const root = mount(Register, siteFeed());
    expect(root.querySelector('ul')).toBeNull();
    expect(live(root)).toContain(
      'An empty register can also mean no ledger was read',
    );
  });
});
