/**
 * Map a recorded test file to a critical area (#1125, decision D8).
 *
 * `area` in the history store means "the critical area this test file maps to"
 * in `.canary/critical-areas.json`. Candidates share the test's file stem
 * (extension and a `.test`/`.spec` marker stripped). Among them, the area
 * sharing the most trailing directory segments wins, then the higher
 * `risk_score`, then the lexically smaller path, so the choice is
 * deterministic.
 */
import type { CriticalArea } from '../../core/inventory-checks.js';

function fileStem(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.[^.]+$/, '').replace(/\.(test|spec)$/, '');
}

/** How many trailing directory segments two paths have in common. */
function sharedTrailingDirs(a: string, b: string): number {
  const x = a.split('/').slice(0, -1).reverse();
  const y = b.split('/').slice(0, -1).reverse();
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}

interface Candidate {
  area: CriticalArea;
  shared: number;
}

function byRank(p: Candidate, q: Candidate): number {
  if (p.shared !== q.shared) return q.shared - p.shared;
  if (p.area.risk_score !== q.area.risk_score) {
    return q.area.risk_score - p.area.risk_score;
  }
  return p.area.path < q.area.path ? -1 : 1;
}

/** The matched area's `path`, or undefined when no area shares the stem. */
export function areaFor(
  testFile: string,
  areas: readonly CriticalArea[],
): string | undefined {
  const stem = fileStem(testFile);
  const ranked = areas
    .filter((a) => fileStem(a.path) === stem)
    .map((a) => ({ area: a, shared: sharedTrailingDirs(testFile, a.path) }))
    .sort(byRank);
  return ranked[0]?.area.path;
}
