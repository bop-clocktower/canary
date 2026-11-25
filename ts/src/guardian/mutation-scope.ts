/**
 * What a PR's mutation run mutates, and how much of it (#486 spec D2, D7).
 *
 * Pure: the diff's added ranges come in, Stryker `mutate` entries come out.
 * Paths leave this module relative to `ts/`, because Stryker runs there so
 * vitest resolves the same configuration as `npm test`.
 *
 * The cap is applied to whole LINES in (path, line) order, never to individual
 * mutants. Stryker can only be told line ranges, so a per-mutant sample would
 * be a promise the run could not keep; a line prefix is exactly what Stryker
 * will mutate, and the report still says "sampled N of M" (D7).
 */

import type { ChangedUnit, LineRange } from './diff-coverage/types.js';

/** The D7 per-PR mutant budget. */
export const MUTANT_CAP = 150;

/**
 * Mutators left out in v1 (spec D8): they mostly produce equivalent or noisy
 * survivors in message text and config objects, which would inflate the D5
 * false-survivor rate the exit criterion is measured on.
 */
export const EXCLUDED_MUTATORS = ['StringLiteral', 'ObjectLiteral'];

/** One file to mutate, `ts/`-relative, with its inclusive 1-based ranges. */
export interface MutationTarget {
  path: string;
  ranges: LineRange[];
}

/** The mutants Stryker's instrumenter places starting on one line. */
export interface LineCount {
  path: string;
  line: number;
  /** The last line any of them reaches; `line` when omitted. */
  endLine?: number;
  /** Mutants a test will run against. */
  mutants: number;
  /**
   * Mutants of an excluded mutator (D8). Stryker reports them as `Ignored`,
   * so they belong in the total it will report but never in the budget.
   */
  ignored?: number;
}

/** The capped selection, and the total it was cut from. */
export interface Sample {
  /** Every mutant on every added line, ignored ones included, before the cap. */
  generated: number;
  /** Runnable mutants on the lines kept. Over the cap only when one line is. */
  planned: number;
  /** Whether the cap cut anything; when not, the diff's own ranges apply. */
  capped: boolean;
  targets: MutationTarget[];
}

const SOURCE_PREFIX = 'ts/src/';

/**
 * Whether a repo-relative path is TypeScript source Stryker should mutate.
 *
 * Test files are the instrument, not the subject; declaration files have no
 * runtime code. `agents/skills/**` scripts are out of scope until they have a
 * vitest coverage mapping (spec fork F3).
 */
function isMutableSource(path: string): boolean {
  return (
    path.startsWith(SOURCE_PREFIX) &&
    path.endsWith('.ts') &&
    !path.endsWith('.d.ts') &&
    !path.endsWith('.test.ts')
  );
}

/** Keep the diff's mutable units, `ts/`-relative and ordered by path. */
export function mutationTargets(units: ChangedUnit[]): MutationTarget[] {
  return units
    .filter((unit) => isMutableSource(unit.path))
    .map((unit) => ({
      path: unit.path.slice('ts/'.length),
      ranges: unit.added_ranges,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Stryker `mutate` entries: `path:start-end`, one per range. */
export function mutateEntries(targets: MutationTarget[]): string[] {
  return targets.flatMap((target) =>
    target.ranges.map(([start, end]) => `${target.path}:${start}-${end}`),
  );
}

/** Merge ranges sorted by start, joining any that overlap or touch. */
function mergeRanges(sorted: LineRange[]): LineRange[] {
  const ranges: LineRange[] = [];
  for (const [start, end] of sorted) {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else ranges.push([start, end]);
  }
  return ranges;
}

const byPathThenLine = (a: LineCount, b: LineCount): number =>
  a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1;

/**
 * Keep the longest (path, line) prefix whose mutants fit the cap.
 *
 * The cut stops at the first line that does not fit instead of skipping ahead
 * to a smaller one, so what is sampled depends only on position. The first
 * line is always kept: a cap that let a single dense line sample nothing would
 * turn a real diff into an abstention.
 *
 * A kept line's range runs to the furthest line its mutants reach. Stryker
 * only generates a mutant that lies wholly inside a range, so a line-only
 * range silently drops every multi-line mutant (a block, a wrapped call).
 */
export function sampleLines(
  counts: LineCount[],
  cap: number = MUTANT_CAP,
): Sample {
  const generated = counts.reduce(
    (sum, c) => sum + c.mutants + (c.ignored ?? 0),
    0,
  );
  const lines = counts.filter((c) => c.mutants > 0).sort(byPathThenLine);
  const runnable = lines.reduce((sum, c) => sum + c.mutants, 0);
  const byPath = new Map<string, LineRange[]>();
  let planned = 0;
  let kept = 0;
  for (let i = 0; i < lines.length;) {
    const { path, line } = lines[i]!;
    const end = Math.max(line, lines[i]!.endLine ?? line);
    // The range [line, end] pulls in every mutant starting inside it, so the
    // line is charged for all of them -- not just its own (dogfood: 177
    // tested under a 150 cap).
    let j = i;
    let cost = 0;
    while (
      j < lines.length &&
      lines[j]!.path === path &&
      lines[j]!.line <= end
    ) {
      cost += lines[j]!.mutants;
      j += 1;
    }
    if (kept > 0 && planned + cost > cap) break;
    const list = byPath.get(path) ?? [];
    list.push([line, end]);
    byPath.set(path, list);
    planned += cost;
    kept += 1;
    i = j;
  }
  const targets = [...byPath].map(([path, ranges]) => ({
    path,
    ranges: mergeRanges(ranges),
  }));
  return { generated, planned, capped: planned < runnable, targets };
}
