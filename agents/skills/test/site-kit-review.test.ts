// @vitest-environment happy-dom
// Regressions for the phase 3a ship-gate review (#1151). Each case is a
// failure scenario a reviewer reproduced against the first cut of the kit:
// a partial (re-run or lost) shard set read as a whole passing run, a
// pattern-valid but impossible timestamp that sorted first and crashed one
// panel into blanking all six, interrupted tests counted as failures, clock
// skew rendered as a negative age, a live region re-inserted on each render,
// and panels added after the load that never got the feed.
import { describe, expect, it, vi } from 'vitest';
import { CanaryPanel, el, pageFeed } from '../lib/site-kit/panel.js';
import {
  formatMeasure,
  isDark,
  logicalRuns,
  passCounts,
  suiteKey,
  timeProblem,
} from '../lib/site-kit/model.js';
import { PipelineHealth } from '../lib/site-kit/panels/pipeline-health.js';
import { PassRate } from '../lib/site-kit/panels/pass-rate.js';
import { FailuresByArea } from '../lib/site-kit/panels/failures-by-area.js';
import { Register } from '../lib/site-kit/panels/register.js';
import { loadFeed } from '../lib/site-kit/canary-site.js';
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

type Run = ReturnType<typeof runRecord>;
const shard = (id: string, index: number, total: number, over = {}) =>
  runRecord({
    id: `${id}-s${index}of${total}`,
    shard: { index, total },
    ...over,
  });
/** A record whose finish matches the timestamp pattern but is no real date. */
const undated = (over = {}): Run => {
  const r = runRecord(over);
  r.run.finished_at = '2026-13-01T00:00:00Z';
  return r;
};
const states = (root: ShadowRoot) =>
  [...root.querySelectorAll('li')].map((li) => li.getAttribute('data-state'));
const latestOf = (runs: Run[]) =>
  logicalRuns(runs).get(suiteKey(SCOPE, 'ts-engine'))![0];

describe('a run missing shards is incomplete, never passing (#1200)', () => {
  it('marks a re-run of only the failed shard incomplete', () => {
    const run = latestOf([shard('123-2', 2, 3)]);
    expect(run.incomplete).toBe(true);
    expect(run.shards).toEqual({ reported: 1, total: 3 });
  });

  it('a full shard set is complete', () => {
    const run = latestOf([1, 2, 3].map((i) => shard('r', i, 3)));
    expect(run.incomplete).toBe(false);
  });

  it('pipeline health says incomplete, not passing', () => {
    const root = mount(
      PipelineHealth,
      siteFeed({ runs: [shard('r', 1, 3), shard('r', 2, 3)] }),
    );
    expect(states(root)).toEqual(['incomplete']);
    expect(root.textContent).toContain('2 of 3 shards reported');
  });

  it('pass rate shows — for it and says why', () => {
    const root = mount(PassRate, siteFeed({ runs: [shard('123-2', 2, 3)] }));
    expect(root.querySelector('li strong')!.textContent).toBe('—');
    expect(root.textContent).not.toContain('100.0%');
    expect(live(root)).toContain('1 run(s) are missing shards');
  });

  it('failures by area treats it as blind', () => {
    const run = shard('r', 1, 2, {
      status: 'failed',
      results: [result({ status: 'failed' })],
    });
    const root = mount(FailuresByArea, siteFeed({ runs: [run] }));
    expect(root.querySelector('table')).toBeNull();
    expect(live(root)).toContain('1 suite(s) have a latest run missing shards');
  });
});

describe('an impossible timestamp is never a recent run', () => {
  it('sorts an undated run last instead of posing as the latest', () => {
    const runs = [
      undated({ id: 'bad' }),
      runRecord({ id: 'good', status: 'failed' }),
    ];
    expect(latestOf(runs).id).toBe('good');
  });

  it('is dark, and names the problem', () => {
    expect(isDark(NaN, NOW)).toBe(true);
    expect(timeProblem(NaN, NOW)).toBe('undated');
    expect(timeProblem(NOW + 2 * DAY, NOW)).toBe('future');
    expect(timeProblem(NOW - DAY, NOW)).toBeNull();
  });

  it('pipeline health shows the dated failing run, not a false pass', () => {
    const runs = [
      undated({ id: 'bad' }),
      runRecord({ id: 'good', status: 'failed' }),
    ];
    expect(states(mount(PipelineHealth, siteFeed({ runs })))).toEqual([
      'failing',
    ]);
  });

  it('pipeline health says so when no run is dated', () => {
    expect(
      states(mount(PipelineHealth, siteFeed({ runs: [undated()] }))),
    ).toEqual(['undated']);
  });

  it('pipeline health flags a run dated more than a day ahead (clock skew)', () => {
    const root = mount(
      PipelineHealth,
      siteFeed({ runs: [runRecord({ finished: iso(NOW + 3 * DAY) })] }),
    );
    expect(states(root)).toEqual(['future']);
  });

  it('pass rate renders an undated run instead of throwing', () => {
    const root = mount(PassRate, siteFeed({ runs: [undated()] }));
    expect(root.querySelector('li strong')!.textContent).toBe('100.0%');
    expect(live(root)).toContain('1 run(s) have no real finish time');
  });
});

describe('interrupted tests did not run', () => {
  it('are left out of the pass-rate denominator, and announced', () => {
    const totals = {
      passed: 100,
      failed: 0,
      flaky: 0,
      skipped: 0,
      timed_out: 0,
      interrupted: 900,
      total: 1000,
    };
    expect(passCounts(totals)).toEqual({ numerator: 100, denominator: 100 });
    const root = mount(
      PassRate,
      siteFeed({ runs: [runRecord({ status: 'cancelled', totals })] }),
    );
    expect(root.querySelector('li')!.textContent).toContain(
      '100.0% (100/100, 900 interrupted)',
    );
    expect(live(root)).toContain('1 run(s) were interrupted');
  });
});

describe('ratios never round up to 100%', () => {
  it('keeps 1 - 1e-13 below 100%', () => {
    expect(formatMeasure(1 - 1e-13, 'ratio')).toBe('99.9%');
  });
});

describe('register clock skew', () => {
  it('a future recorded_at is named, never a negative age', () => {
    const root = mount(
      Register,
      siteFeed({
        register: [registerRow({ recorded_at: iso(NOW + 2 * DAY) })],
      }),
    );
    expect(root.textContent).not.toMatch(/-\d+ day/);
    expect(root.textContent).toContain('recorded in the future (clock skew)');
    expect(live(root)).toContain('1 row(s) have a date this page cannot age');
  });
});

class Thrower extends CanaryPanel {
  get heading() {
    return 'Thrower';
  }
  build(): never {
    throw new RangeError('Invalid time value');
  }
}

describe('panel base', () => {
  it('a panel whose build throws refuses only itself, with the reason', () => {
    const root = mount(Thrower, siteFeed());
    expect(live(root)).toBe(
      'This panel could not render the feed: Invalid time value',
    );
    expect(root.querySelector('h2')!.textContent).toBe('Thrower');
  });

  it('never removes the live region across renders', () => {
    const root = mount(PassRate, siteFeed({ runs: [runRecord()] }));
    const region = root.querySelector('[role="status"]')!;
    const seen = new MutationObserver(() => {});
    seen.observe(root, { childList: true, subtree: true });
    (root.host as HTMLElement & { feed: unknown }).feed = siteFeed();
    const removed = seen.takeRecords().flatMap((m) => [...m.removedNodes]);
    seen.disconnect();
    expect(removed).not.toContain(region);
    expect(region.isConnected).toBe(true);
  });

  it('el() still builds a plain element', () => {
    expect(el('p', {}, 'x').outerHTML).toBe('<p>x</p>');
  });
});

describe('a panel added after the feed loaded', () => {
  it('adopts the loaded feed', async () => {
    document.head.innerHTML = '<meta name="canary-feed" content="site.json">';
    const doc = siteFeed({ runs: [runRecord()] });
    await loadFeed(
      document,
      vi.fn(async () => ({ ok: true, status: 200, json: async () => doc })),
    );
    const late = document.createElement('canary-pass-rate') as HTMLElement & {
      feed: unknown;
    };
    document.body.append(late);
    expect(late.feed).toBe(doc);
    expect(late.shadowRoot!.querySelector('li strong')!.textContent).toBe(
      '100.0%',
    );
  });

  it('adopts the refusal too, rather than "No feed loaded yet."', async () => {
    document.head.innerHTML = '<meta name="canary-feed" content="site.json">';
    await loadFeed(
      document,
      vi.fn(async () => ({ ok: false, status: 500, json: async () => null })),
    );
    const late = document.createElement('canary-flaky');
    document.body.append(late);
    expect(live(late.shadowRoot!)).toContain('HTTP 500');
    pageFeed.doc = null;
    pageFeed.problem = null;
  });
});
