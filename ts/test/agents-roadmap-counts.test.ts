/**
 * AGENTS.md states roadmap counts as literal numbers, and nothing checked them.
 *
 * The drift is not hypothetical. During #628 the prose read `38` and `19` while
 * the file carried 45 rows, and both numbers were corrected by hand after a
 * reviewer noticed. Adding rows for #626/#590/#629 would have staled `47` the
 * same way. A hand-maintained count in a doc nobody diffs against the data is a
 * false-green surface: it reads as verified because it is specific.
 *
 * The invariant: every roadmap-row count asserted in AGENTS.md must equal the
 * number of rows docs/roadmap.md actually links. The counts are extracted from
 * the prose by pattern, so a sentence that stops matching is itself a failure —
 * a silently-unguarded claim is the thing being prevented.
 *
 * Deliberately NOT checked: the open-issue side of `N of M carry the label`.
 * That number lives on GitHub, so it cannot be verified offline. The test says
 * so out loud rather than implying the whole sentence is covered — a check that
 * quietly inspects half a claim is the shape this file exists to catch (#508).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AGENTS = join(REPO_ROOT, 'AGENTS.md');
const ROADMAP = join(REPO_ROOT, 'docs', 'roadmap.md');

/** Rows the roadmap links to a ticket — the number AGENTS.md describes. */
function linkedRowCount(): number {
  const text = readFileSync(ROADMAP, 'utf-8');
  const ids = [...text.matchAll(/\*\*External-ID:\*\*\s*github:\S+?#(\d+)/g)];
  return new Set(ids.map((m) => m[1])).size;
}

/**
 * Every roadmap-row count claimed in AGENTS.md, with the sentence it came from
 * so a failure names the prose to edit rather than only the number.
 */
function claimedCounts(): Array<{ claim: number; context: string }> {
  const text = readFileSync(AGENTS, 'utf-8');
  const patterns = [
    /All (\d+) rows carry one — 47 as of #628/,
    /All (\d+) rows\s+now carry an `External-ID`/,
    /\((\d+) of \d+ open issues carry the\s+label today/,
  ];
  return patterns.flatMap((pattern) => {
    const hit = text.match(pattern);
    return hit === null
      ? []
      : [{ claim: Number(hit[1]), context: hit[0].replace(/\s+/g, ' ') }];
  });
}

describe('AGENTS.md roadmap counts', () => {
  it('inspects a non-zero number of claims', () => {
    // A pattern that stops matching would otherwise pass every assertion below
    // by checking nothing at all.
    expect(claimedCounts().length).toBe(3);
  });

  it('matches the number of linked rows in docs/roadmap.md', () => {
    const actual = linkedRowCount();
    for (const { claim, context } of claimedCounts()) {
      expect(
        claim,
        `AGENTS.md says "${context}" but docs/roadmap.md links ${actual} rows`,
      ).toBe(actual);
    }
  });

  it('reads a real roadmap rather than an empty one', () => {
    expect(linkedRowCount()).toBeGreaterThan(0);
  });
});
