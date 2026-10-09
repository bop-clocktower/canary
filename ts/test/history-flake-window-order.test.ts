/**
 * The flake-window disclosure must describe the runs `queryFlaky` read.
 *
 * `queryFlaky` sorts by timestamp before taking the window (#604): a
 * backfilled older run appended last is NOT in the newest window. The
 * disclosure sliced in APPEND order instead, so with a backfill it vouched
 * `flaky_measurable` for a run the query never read.
 */

import { describe, expect, it } from 'vitest';

import { describeFlakyWindow } from '../src/history/flake/window.js';

describe('describeFlakyWindow ordering', () => {
  it('reads the newest runs by timestamp, not by append order', async () => {
    const store = {
      readAll: async () => [
        // Newest run, appended first: vitest cannot measure retry flakes.
        {
          suite: 'api',
          timestamp: '2026-02-01T00:00:00+00:00',
          reporter_format: 'vitest',
        },
        // Older run backfilled LAST: outside a window of 1.
        {
          suite: 'api',
          timestamp: '2026-01-01T00:00:00+00:00',
          reporter_format: 'playwright',
        },
      ],
    };
    const win = await describeFlakyWindow(store, 1, null);
    expect(win?.flaky_measurable).toBe('no');
  });
});
