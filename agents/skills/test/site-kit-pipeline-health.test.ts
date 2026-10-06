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
});
