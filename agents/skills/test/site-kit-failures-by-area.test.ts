// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { FailuresByArea } from '../lib/site-kit/panels/failures-by-area.js';
import {
  DAY,
  iso,
  live,
  mount,
  NOW,
  registerRow,
  result,
  runRecord,
  siteFeed,
} from './site-kit-helpers.js';

/** {area: [failed, quarantined, notRun]} from the rendered table. */
function table(root: ShadowRoot) {
  return Object.fromEntries(
    [...root.querySelectorAll('tbody tr')].map((tr) => {
      const [area, ...counts] = [...tr.querySelectorAll('td')].map(
        (td) => td.textContent,
      );
      return [area, counts.map(Number)];
    }),
  );
}

describe('<canary-failures-by-area> (P1, P1a)', () => {
  it('counts failed and timed_out as failed, skipped and interrupted as not run', () => {
    const run = runRecord({
      status: 'failed',
      results: [
        result({ title: 'a', status: 'failed', area: 'checkout' }),
        result({ title: 'b', status: 'timed_out', area: 'checkout' }),
        result({ title: 'c', status: 'skipped', area: 'checkout' }),
        result({ title: 'd', status: 'interrupted', area: 'search' }),
        result({ title: 'e', status: 'passed', area: 'search' }),
      ],
    });
    expect(table(mount(FailuresByArea, siteFeed({ runs: [run] })))).toEqual({
      checkout: [2, 0, 1],
      search: [0, 0, 1],
    });
  });

  it('files a null area under (unassigned), never drops it', () => {
    const run = runRecord({
      status: 'failed',
      results: [result({ status: 'failed' })],
    });
    expect(table(mount(FailuresByArea, siteFeed({ runs: [run] })))).toEqual({
      '(unassigned)': [1, 0, 0],
    });
  });

  it('counts a failed or skipped test in the register as quarantined', () => {
    const run = runRecord({
      status: 'failed',
      results: [
        result({ title: 'q1', status: 'failed', area: 'x' }),
        result({ title: 'q2', status: 'skipped', area: 'x' }),
        result({ title: 'ok', status: 'passed', area: 'x' }),
      ],
    });
    const register = ['q1', 'q2', 'ok'].map((title) => registerRow({ title }));
    expect(
      table(mount(FailuresByArea, siteFeed({ runs: [run], register }))),
    ).toEqual({
      x: [0, 2, 0],
    });
  });

  it('a register row from another scope does not quarantine', () => {
    const run = runRecord({
      status: 'failed',
      results: [result({ status: 'failed' })],
    });
    const register = [registerRow({ scope: { id: 'other', env: 'ci' } })];
    expect(
      table(mount(FailuresByArea, siteFeed({ runs: [run], register }))),
    ).toEqual({
      '(unassigned)': [1, 0, 0],
    });
  });

  it('reads only the latest run of each suite', () => {
    const runs = [
      runRecord({
        id: 'old',
        status: 'failed',
        finished: iso(NOW - 3 * DAY),
        results: [result({ status: 'failed', area: 'old' })],
      }),
      runRecord({ id: 'new', results: [result()] }),
    ];
    const root = mount(FailuresByArea, siteFeed({ runs }));
    expect(root.querySelector('table')).toBeNull();
    expect(root.textContent).toContain(
      'No failed, quarantined or not-run tests in the latest run of 1 suite(s).',
    );
  });

  it('announces a suite whose latest run carries no per-test results', () => {
    const runs = [
      runRecord({ results: null }),
      runRecord({
        suite: 'e2e',
        status: 'failed',
        results: [result({ status: 'failed' })],
      }),
    ];
    const root = mount(FailuresByArea, siteFeed({ runs }));
    expect(live(root)).toContain('1 suite(s) carry no per-test results');
    expect(table(root)).toEqual({ '(unassigned)': [1, 0, 0] });
  });

  it('abstains with no runs', () => {
    const root = mount(FailuresByArea, siteFeed());
    expect(live(root)).toBe('No runs in the feed.');
  });
});
