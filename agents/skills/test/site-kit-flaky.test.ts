// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { Flaky } from '../lib/site-kit/panels/flaky.js';
import {
  live,
  mount,
  result,
  runRecord,
  SCOPE,
  siteFeed,
} from './site-kit-helpers.js';

const flakyRow = (title: string, flaky_runs: number) => ({
  scope: SCOPE,
  suite: 'ts-engine',
  title,
  file: 'test/a.test.ts',
  flaky_runs,
  window_runs: 30,
});
const withResults = [runRecord({ results: [result()] })];

describe('<canary-flaky> (criterion 23)', () => {
  it('lists each distinct test once with flaky runs over window runs', () => {
    const root = mount(
      Flaky,
      siteFeed({ runs: withResults, flaky: [flakyRow('a', 3)] }),
    );
    const items = root.querySelectorAll('li');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('flaky in 3/30 runs');
    expect(root.textContent).toContain('1 distinct flaky test(s)');
  });

  it('puts the flakiest first', () => {
    const root = mount(
      Flaky,
      siteFeed({
        runs: withResults,
        flaky: [flakyRow('low', 1), flakyRow('high', 5)],
      }),
    );
    expect(root.querySelector('li strong')!.textContent).toBe('high');
  });

  it('says no test flaked when the window carried results', () => {
    const root = mount(Flaky, siteFeed({ runs: withResults }));
    expect(root.textContent).toContain('No test flaked in the window.');
    expect(live(root)).toBe('');
  });

  it('abstains when no run carries per-test results', () => {
    const root = mount(Flaky, siteFeed({ runs: [runRecord()] }));
    expect(root.textContent).not.toContain('No test flaked');
    expect(live(root)).toContain('No run carries per-test results');
  });

  it('abstains with no runs', () => {
    expect(live(mount(Flaky, siteFeed()))).toBe(
      'No runs in the feed, so flakiness was not measured.',
    );
  });
});
