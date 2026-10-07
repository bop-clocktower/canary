// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { PipelineHealth } from '../lib/site-kit/panels/pipeline-health.js';
import {
  DAY,
  iso,
  live,
  mount,
  NOW,
  runRecord,
  SCOPE,
  siteFeed,
} from './site-kit-helpers.js';

const declared = (...names: string[]) =>
  names.map((suite) => ({ scope: SCOPE, suite }));
const states = (root: ShadowRoot) =>
  [...root.querySelectorAll('li')].map((li) => li.getAttribute('data-state'));

describe('<canary-pipeline-health> (criterion 10)', () => {
  it('renders a suite whose latest run passed inside the window as passing', () => {
    const root = mount(
      PipelineHealth,
      siteFeed({ suites: declared('ts-engine'), runs: [runRecord()] }),
    );
    expect(states(root)).toEqual(['passing']);
    expect(root.querySelector('li')!.textContent).toContain(
      'canary/ci · ts-engine',
    );
  });

  it('renders failing when any shard of the latest run failed', () => {
    const shard = (i: number, status: 'passed' | 'failed') =>
      runRecord({ id: `r-s${i}of2`, shard: { index: i, total: 2 }, status });
    const root = mount(
      PipelineHealth,
      siteFeed({ runs: [shard(1, 'passed'), shard(2, 'failed')] }),
    );
    expect(states(root)).toEqual(['failing']);
  });

  it('renders a cancelled latest run as cancelled, never passing', () => {
    const root = mount(
      PipelineHealth,
      siteFeed({ runs: [runRecord({ status: 'cancelled' })] }),
    );
    expect(states(root)).toEqual(['cancelled']);
  });

  it('renders dark after DARK_AFTER_DAYS whatever the status was', () => {
    const root = mount(
      PipelineHealth,
      siteFeed({
        suites: declared('stale', 'fresh'),
        runs: [
          runRecord({ suite: 'stale', finished: iso(NOW - 8 * DAY) }),
          runRecord({ suite: 'fresh', finished: iso(NOW - 6 * DAY) }),
        ],
      }),
    );
    expect(states(root)).toEqual(['dark', 'passing']);
    expect(root.textContent).toContain('no run in 7 days');
  });

  it('renders a declared suite with no runs as never reported', () => {
    const root = mount(
      PipelineHealth,
      siteFeed({
        suites: declared('ts-engine', 'e2e'),
        runs: [runRecord()],
      }),
    );
    expect(states(root)).toEqual(['passing', 'never-reported']);
  });

  it('shows an undeclared suite that reported anyway', () => {
    const root = mount(
      PipelineHealth,
      siteFeed({
        suites: declared('ts-engine'),
        runs: [runRecord({ suite: 'extra' })],
      }),
    );
    expect(states(root)).toEqual(['never-reported', 'passing']);
  });

  it('with suites null, says none are declared and invents no never-reported row (D12)', () => {
    const root = mount(PipelineHealth, siteFeed({ runs: [runRecord()] }));
    expect(live(root)).toContain('No expected suites are declared');
    expect(states(root)).toEqual(['passing']);
  });

  it('abstains when nothing is declared and nothing reported', () => {
    const root = mount(PipelineHealth, siteFeed());
    expect(root.querySelector('ul')).toBeNull();
    expect(live(root)).toContain('No expected suites are declared');
    expect(live(root)).toContain('No suite has reported a run.');
  });

  it('abstains when zero suites are declared and none reported', () => {
    const root = mount(PipelineHealth, siteFeed({ suites: [] }));
    expect(live(root)).toBe('No suite has reported a run.');
  });

  it('cards each suite with its last run and a run strip, oldest first', () => {
    const root = mount(
      PipelineHealth,
      siteFeed({
        suites: declared('ts-engine', 'e2e'),
        runs: [
          runRecord({
            id: 'old',
            status: 'failed',
            finished: iso(NOW - 2 * DAY),
          }),
          runRecord({ id: 'new', finished: iso(NOW - 3 * 3_600_000) }),
        ],
      }),
    );
    const [engine, e2e] = root.querySelectorAll('li');
    expect(engine.textContent).toContain('last run 3h ago · 1/1 passed');
    expect(
      [...engine.querySelectorAll('.strip span')].map((s) =>
        s.getAttribute('data-state'),
      ),
    ).toEqual(['failed', 'passed']);
    // A suite that never reported has no strip: an empty strip would read as
    // "no failures", which nothing measured.
    expect(e2e.querySelector('.strip')).toBeNull();
    expect(e2e.textContent).toContain('no run in the feed');
    expect(root.querySelector('.summary')!.textContent).toBe(
      '1 of 2 suite(s) passing',
    );
    // A suite that never reported is unproven, not failed: grey, not red.
    expect(root.querySelector('.summary')!.getAttribute('data-state')).toBe(
      'dark',
    );
  });

  it('labels the run strip for assistive tech instead of hiding it', () => {
    const root = mount(
      PipelineHealth,
      siteFeed({
        suites: declared('ts-engine'),
        runs: [
          runRecord({
            id: 'a',
            status: 'failed',
            finished: iso(NOW - 2 * DAY),
          }),
          runRecord({ id: 'b', finished: iso(NOW - DAY) }),
        ],
      }),
    );
    const strip = root.querySelector('.strip')!;
    expect(strip.getAttribute('aria-hidden')).toBeNull();
    expect(strip.getAttribute('role')).toBe('img');
    expect(strip.getAttribute('aria-label')).toBe(
      'last 2 runs: 1 passed, 1 failed',
    );
  });

  // Review findings (ship gate): a card or summary line must never print a
  // confident count over a run that measured nothing, or a part of a suite.
  it('prints no 0/0 for a run that counted no tests', () => {
    const run = runRecord({ totals: { passed: 0, total: 0 } });
    const li = mount(
      PipelineHealth,
      siteFeed({ suites: declared('ts-engine'), runs: [run] }),
    ).querySelector('li')!;
    expect(li.textContent).not.toContain('0/0');
    expect(li.textContent).toContain('— (no tests counted)');
  });

  it('prints no n/n for a run missing shards (#1200)', () => {
    const shard = runRecord({
      id: 'r-s1of2',
      shard: { index: 1, total: 2 },
      totals: { passed: 40, total: 40 },
    });
    const li = mount(
      PipelineHealth,
      siteFeed({ suites: declared('ts-engine'), runs: [shard] }),
    ).querySelector('li')!;
    expect(li.textContent).not.toContain('40/40');
    expect(li.textContent).toContain('— (1 of 2 shards reported)');
  });

  it.each([
    ['null', null],
    ['empty', []],
  ])(
    'with suites %s, shows no "n of n passing" line: it has no declared denominator (D12)',
    (_, suites) => {
      const root = mount(
        PipelineHealth,
        siteFeed({ suites, runs: [runRecord()] }),
      );
      expect(root.querySelector('.summary')).toBeNull();
    },
  );

  it('colours suites nobody measured recently grey, not failure red', () => {
    const root = mount(
      PipelineHealth,
      siteFeed({
        suites: declared('ts-engine'),
        runs: [runRecord({ finished: iso(NOW - 30 * DAY) })],
      }),
    );
    expect(root.querySelector('.summary')!.getAttribute('data-state')).toBe(
      'dark',
    );
  });
});
