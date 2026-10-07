// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { Summary } from '../lib/site-kit/panels/summary.js';
import {
  DAY,
  iso,
  live,
  mount,
  NOW,
  registerRow,
  result,
  runRecord,
  SCOPE,
  siteFeed,
} from './site-kit-helpers.js';

const declared = (...names: string[]) =>
  names.map((suite) => ({ scope: SCOPE, suite }));
const tiles = (root: ShadowRoot) =>
  Object.fromEntries(
    [...root.querySelectorAll('li[data-tile]')].map((li) => [
      li.getAttribute('data-tile'),
      li.querySelector('strong')!.textContent,
    ]),
  );
const flaky = {
  scope: SCOPE,
  suite: 'ts-engine',
  title: 't',
  file: 'test/a.test.ts',
  flaky_runs: 1,
  window_runs: 30,
};

describe('<canary-summary>', () => {
  it('counts suites passing, failed tests, flaky tests and the register', () => {
    const root = mount(
      Summary,
      siteFeed({
        suites: declared('ts-engine', 'e2e'),
        runs: [
          runRecord({
            status: 'failed',
            results: [
              result({ status: 'failed' }),
              result({ status: 'timed_out' }),
              result(),
            ],
          }),
        ],
        flaky: [flaky],
        register: [registerRow(), registerRow({ title: 'other' })],
      }),
    );
    expect(tiles(root)).toEqual({
      suites: '0 of 2',
      failed: '2',
      flaky: '1',
      register: '2',
    });
    // e2e never reported: its failures are unknown, and the tile says so.
    expect(live(root)).toBe(
      '1 suite(s) not counted in failed tests (1 never reported).',
    );
  });

  it('colours each tile by what it found', () => {
    const root = mount(
      Summary,
      siteFeed({
        suites: declared('ts-engine'),
        runs: [runRecord()],
        flaky: [flaky],
        register: [registerRow()],
      }),
    );
    const state = (k: string) =>
      root.querySelector(`li[data-tile="${k}"]`)!.getAttribute('data-state');
    expect(state('suites')).toBe('passing');
    expect(state('failed')).toBe('passing');
    expect(state('flaky')).toBe('degraded');
  });

  it('never shows a rate or an overall number (ADR 0036)', () => {
    const root = mount(
      Summary,
      siteFeed({ suites: declared('ts-engine'), runs: [runRecord()] }),
    );
    expect(root.textContent).not.toMatch(/%|score|overall|average|\/\s*10\b/i);
  });

  it('abstains on suites when none are declared, rather than guessing a denominator', () => {
    const root = mount(Summary, siteFeed({ runs: [runRecord()] }));
    expect(tiles(root).suites).toBe('—');
    expect(live(root)).toContain('No expected suites are declared');
  });

  it('abstains on failed tests when a latest run is missing shards', () => {
    const shard = runRecord({ id: 'r-s1of2', shard: { index: 1, total: 2 } });
    const root = mount(Summary, siteFeed({ runs: [shard] }));
    expect(tiles(root).failed).toBe('—');
    expect(live(root)).toContain('missing shards');
  });

  it('abstains on flaky tests when no run carried per-test results', () => {
    const root = mount(Summary, siteFeed({ runs: [runRecord()] }));
    expect(tiles(root).flaky).toBe('—');
    expect(live(root)).toContain('flakiness was not measured');
  });

  it('abstains on an empty register, which cannot be told from an unread one (#1199)', () => {
    const root = mount(Summary, siteFeed({ runs: [runRecord()] }));
    expect(tiles(root).register).toBe('—');
    expect(live(root)).toContain('register');
  });

  // Review findings (ship gate): the failed tile counted every suite's latest
  // run, so a run that measured nothing summed in as a green 0.
  describe('failed tests counts only measured runs', () => {
    const state = (root: ShadowRoot, k: string) =>
      root.querySelector(`li[data-tile="${k}"]`)!.getAttribute('data-state');

    it.each([
      [
        'a cancelled run with no tests',
        runRecord({ status: 'cancelled', totals: { passed: 0, total: 0 } }),
      ],
      [
        'a passed run that counted no tests',
        runRecord({ totals: { passed: 0, total: 0 } }),
      ],
      [
        'a run whose tests were all interrupted',
        runRecord({
          status: 'failed',
          totals: { passed: 0, interrupted: 5, total: 5 },
        }),
      ],
      ['a dark run', runRecord({ finished: iso(NOW - 30 * DAY) })],
      ['a future-dated run', runRecord({ finished: iso(NOW + 3 * DAY) })],
    ])('shows — for %s, never a green 0', (_, run) => {
      const root = mount(
        Summary,
        siteFeed({ suites: declared('ts-engine'), runs: [run] }),
      );
      expect(tiles(root).failed).toBe('—');
      expect(state(root, 'failed')).toBeNull();
      expect(live(root)).toContain('not counted');
    });

    it('counts what was measured, uncoloured, and names the suites left out', () => {
      const root = mount(
        Summary,
        siteFeed({
          suites: declared('ts-engine', 'e2e', 'api'),
          runs: [runRecord()],
        }),
      );
      expect(tiles(root).failed).toBe('0');
      expect(state(root, 'failed')).toBeNull();
      expect(live(root)).toContain('2 suite(s) not counted');
    });

    it("keeps another suite's real failures visible when one is missing shards", () => {
      const root = mount(
        Summary,
        siteFeed({
          suites: declared('ts-engine', 'e2e'),
          runs: [
            runRecord({ id: 'a-s1of2', shard: { index: 1, total: 2 } }),
            runRecord({
              suite: 'e2e',
              status: 'failed',
              totals: { passed: 3, failed: 12, total: 15 },
            }),
          ],
        }),
      );
      expect(tiles(root).failed).toBe('12');
      expect(state(root, 'failed')).toBe('failing');
      expect(live(root)).toContain('1 suite(s) not counted');
    });
  });

  it('abstains on suites when an empty list is declared', () => {
    const root = mount(Summary, siteFeed({ suites: [], runs: [runRecord()] }));
    expect(tiles(root).suites).toBe('—');
  });

  it('colours suites nobody measured recently grey, not failure red', () => {
    const root = mount(
      Summary,
      siteFeed({
        suites: declared('ts-engine'),
        runs: [runRecord({ finished: iso(NOW - 30 * DAY) })],
      }),
    );
    expect(
      root.querySelector('li[data-tile="suites"]')!.getAttribute('data-state'),
    ).toBe('dark');
  });

  it('abstains outright with no runs', () => {
    const root = mount(Summary, siteFeed());
    expect(root.querySelector('li')).toBeNull();
    expect(live(root)).toBe(
      'No runs in the feed, so there is nothing to sum up.',
    );
  });
});
