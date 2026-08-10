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
 * The `N of M open issues carry the label today` sentence is a different
 * quantity — labelled *issues*, not linked *rows* — and it was wrongly folded
 * into the row-count list, passing only because both sides happened to read 51
 * (#640). Asserting a labelled-issue count against a row count fails on a
 * correct edit (archive a row, keep the issue) and never checks the claim it
 * appears to guard: false red and false green from one line.
 *
 * It is guarded here on the one axis that *is* derivable offline: the sentence
 * names a single exception ("the one that does not is #587"), so `M - N` must
 * be exactly 1 and the named issue must still be there. Change the ratio
 * without touching the exception and the prose contradicts itself; this catches
 * that. Deliberately still NOT checked: whether M is the true open-issue count
 * or #587 is really unlabelled — both live on GitHub. Saying which half is
 * covered out loud is the point; a check that quietly inspects half a claim is
 * the shape this file exists to catch (#508).
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
  ];
  return patterns.flatMap((pattern) => {
    const hit = text.match(pattern);
    return hit === null
      ? []
      : [{ claim: Number(hit[1]), context: hit[0].replace(/\s+/g, ' ') }];
  });
}

/**
 * The label-coverage sentence: `N of M open issues carry the label today; the
 * one that does not is #E`. Returns null when the prose no longer reads that
 * way, which the tests treat as a failure rather than as nothing to check.
 */
function labelCoverageClaim(): {
  labelled: number;
  open: number;
  exception: string;
  context: string;
} | null {
  const text = readFileSync(AGENTS, 'utf-8');
  const hit = text.match(
    /\((\d+) of (\d+) open issues carry the\s+label today; the one that does not is #(\d+)/,
  );
  return hit === null
    ? null
    : {
        labelled: Number(hit[1]),
        open: Number(hit[2]),
        exception: `#${hit[3]}`,
        context: hit[0].replace(/\s+/g, ' '),
      };
}

describe('AGENTS.md roadmap counts', () => {
  it('inspects a non-zero number of claims', () => {
    // A pattern that stops matching would otherwise pass every assertion below
    // by checking nothing at all.
    expect(claimedCounts().length).toBe(2);
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

describe('AGENTS.md label-coverage claim', () => {
  it('still finds the sentence it claims to inspect', () => {
    // Without this the two assertions below vacuously pass on a null claim —
    // zero matched is an abstention, not a green.
    expect(labelCoverageClaim()).not.toBeNull();
  });

  it('leaves exactly one open issue unlabelled, as the prose says', () => {
    const claim = labelCoverageClaim();
    expect(claim).not.toBeNull();
    // Non-null narrowed by hand: `expect` carries no type predicate.
    const { labelled, open, exception, context } = claim!;
    expect(
      open - labelled,
      `AGENTS.md says "${context}" — ${open - labelled} of the open issues ` +
        `are unlabelled, but the prose names exactly one (${exception})`,
    ).toBe(1);
  });
});
