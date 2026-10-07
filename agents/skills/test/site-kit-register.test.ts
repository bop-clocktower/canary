// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { Register } from '../lib/site-kit/panels/register.js';
import {
  assessment,
  DAY,
  iso,
  live,
  mount,
  NOW,
  registerRow,
  SCOPE,
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

  // #1199: starling marks a dark ledger with a not-assessed assessment.
  const unread = assessment({
    scope: SCOPE,
    source: 'canary.katana',
    metric: 'register',
    status: 'not-assessed',
    value: null,
    unit: null,
    reason: 'no quarantine ledger at .canary/quarantine.json',
    evidence: { tier: null, denominator: null },
    sources: [],
  });

  it('says not assessed, with the reason, when the ledger was not read (#1199)', () => {
    const root = mount(Register, siteFeed({ assessments: [unread] }));
    expect(root.querySelector('ul')).toBeNull();
    expect(live(root)).toContain(
      'Not assessed — no quarantine ledger at .canary/quarantine.json',
    );
    expect(live(root)).not.toContain('No skipped or removed tests');
  });

  it('says there are no entries when the ledger was read and is empty (#1199)', () => {
    const root = mount(Register, siteFeed());
    expect(root.querySelector('ul')).toBeNull();
    expect(live(root)).toBe('No skipped or removed tests.');
  });

  it('ignores a not-assessed register metric from another source', () => {
    const other = { ...unread, source: 'canary.ci-ready' };
    const root = mount(Register, siteFeed({ assessments: [other] }));
    expect(live(root)).toBe('No skipped or removed tests.');
  });
});
