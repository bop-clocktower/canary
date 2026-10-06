// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { PassRate } from '../lib/site-kit/panels/pass-rate.js';
import {
  DAY,
  iso,
  live,
  mount,
  NOW,
  runRecord,
  siteFeed,
} from './site-kit-helpers.js';

const totals = (over: Record<string, number>) => ({
  passed: 0,
  failed: 0,
  flaky: 0,
  skipped: 0,
  timed_out: 0,
  interrupted: 0,
  total: 0,
  ...over,
});
const rates = (root: ShadowRoot) =>
  [...root.querySelectorAll('li strong')].map((s) => s.textContent);

describe('<canary-pass-rate> (criterion 9)', () => {
  it('renders 996/1000 as 99.6%, never 100%', () => {
    const run = runRecord({
      status: 'failed',
      totals: totals({ passed: 996, failed: 4, total: 1000 }),
    });
    const root = mount(PassRate, siteFeed({ runs: [run] }));
    expect(rates(root)).toEqual(['99.6%']);
    expect(root.textContent).not.toContain('100.0%');
  });

  it('renders an empty denominator as —, never 0%, and announces it', () => {
    const run = runRecord({ totals: totals({ skipped: 3, total: 3 }) });
    const root = mount(PassRate, siteFeed({ runs: [run] }));
    expect(rates(root)).toEqual(['—']);
    expect(root.textContent).not.toContain('0.0%');
    expect(live(root)).toContain('1 run(s) counted no tests');
  });

  it('counts a recovered flake as a pass', () => {
    const run = runRecord({
      totals: totals({ passed: 1, flaky: 1, total: 2 }),
    });
    expect(rates(mount(PassRate, siteFeed({ runs: [run] })))).toEqual([
      '100.0%',
    ]);
  });

  it('lists the trend newest first', () => {
    const runs = [
      runRecord({ id: 'a', finished: iso(NOW - 3 * DAY) }),
      runRecord({
        id: 'b',
        status: 'failed',
        finished: iso(NOW - DAY),
        totals: totals({ passed: 1, failed: 1, total: 2 }),
      }),
    ];
    const root = mount(PassRate, siteFeed({ runs }));
    expect(rates(root)).toEqual(['50.0%', '100.0%']);
    expect(root.querySelector('time')!.getAttribute('datetime')).toBe(
      iso(NOW - DAY),
    );
  });

  it('counts the shards of one run once', () => {
    const shard = (i: number) =>
      runRecord({
        id: `r-s${i}of2`,
        shard: { index: i, total: 2 },
        status: 'failed',
        totals: totals({ passed: 1, failed: 1, total: 2 }),
      });
    expect(
      rates(mount(PassRate, siteFeed({ runs: [shard(1), shard(2)] }))),
    ).toEqual(['50.0%']);
  });

  it('abstains with no runs', () => {
    const root = mount(PassRate, siteFeed());
    expect(root.querySelector('ol')).toBeNull();
    expect(live(root)).toBe('No runs in the feed, so there is no pass rate.');
  });
});
