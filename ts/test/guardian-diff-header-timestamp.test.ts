/**
 * A plain `diff -u` header carries a tab-separated timestamp after the path.
 *
 * `walkDiff` documents plain `diff -u` input (no `diff --git` separator) as
 * supported, but `headerPath` kept everything after `+++ `, so the path became
 * `src/x.ts\t2026-...`: its extension no longer read as source, the unit was
 * dropped as heuristic noise, and coverage/suppression lookups missed it.
 *
 * Found by bug-fleet (area A2, base b0e258bd).
 */

import { describe, expect, it } from 'vitest';

import { scopeDiff } from '../src/guardian/pr-check.js';

describe('scopeDiff: plain diff -u headers with timestamps', () => {
  it('strips the tab-separated timestamp from the header path', () => {
    const diff = [
      '--- a/src/x.ts\t2026-10-09 10:00:00.000000000 +0000',
      '+++ b/src/x.ts\t2026-10-09 10:05:00.000000000 +0000',
      '@@ -0,0 +1,1 @@',
      '+export const x = 1;',
      '',
    ].join('\n');
    expect(scopeDiff(diff).map((u) => u.path)).toEqual(['src/x.ts']);
  });
});
