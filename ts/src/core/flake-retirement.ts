/**
 * Which rows of a flakiness window still count, given the inventory and the
 * working tree (#1500, #1561).
 *
 * A deleted test kept failing `canary ci-ready` until it aged out of the window,
 * on PRs that never touched it. This retires rows from deleted FILES; the rule
 * and its six guards are on `retireDeletedFiles` in `retire-deleted-files.ts`.
 * Pure: callers pass the windows, the parsed inventory and a
 * {@link WorkingTree} in.
 */
import type { SignalRun, SuiteWindow, WindowedRun } from './flake-signals.js';
import type { InventoryInput } from './inventory-checks.js';
import {
  onDiskIn,
  retireDeletedFiles,
  type KeptFile,
  type LiveFiles,
  type RetiredTest,
  type TitleMatch,
} from './retire-deleted-files.js';
import type { WorkingTree } from './working-tree.js';

/**
 * What retirement did to a flakiness score. `applied: false` is an abstention:
 * every row scored as if retirement did not exist, and `reason` says why. Never
 * read `retired_count: 0` without `applied`.
 */
export interface FlakinessRetirement {
  applied: boolean;
  reason: string | null;
  retired_count: number;
  retired: (RetiredTest & { suite: string })[];
  /** Files missing from the inventory that scored anyway, and why. */
  kept: (KeptFile & { suite: string })[];
  /** Retired tests whose title lives on in a live file: a rename, maybe. */
  title_matches: (TitleMatch & { suite: string })[];
  unmatched_rows: number;
}

/** What the inventory says exists, or why it can say nothing about retirement. */
function liveFilesOf(
  inventory: InventoryInput,
): LiveFiles | { reason: string } {
  if (!inventory.ok) return { reason: inventory.reason };
  const { files, skipped, generated } = inventory.inventory;
  // Zero tests is "nothing to match against", the same abstention `canary
  // inventory` makes by writing no file at all; it is not "everything retired".
  if (!files.some((f) => f.tests.length > 0)) {
    return { reason: '.canary/test-inventory.json lists no tests' };
  }
  // The schema is documented for hand-written inventories, so entries are not
  // trusted to carry their paths. A `skipped` entry is unreadable, not deleted.
  const listed: unknown[] = [
    ...files.map((f) => f.path),
    ...(Array.isArray(skipped) ? skipped.map((s) => s?.name) : []),
  ];
  return {
    paths: listed.filter((p): p is string => typeof p === 'string'),
    generated: typeof generated === 'string' ? generated : null,
  };
}

function notApplied(reason: string): FlakinessRetirement {
  return {
    applied: false,
    reason,
    retired_count: 0,
    retired: [],
    kept: [],
    title_matches: [],
    unmatched_rows: 0,
  };
}

/**
 * Retire each suite's rows against the inventory and the working tree, or
 * score everything and say why not. With no tree to check, nothing retires: the
 * inventory alone cannot say a file is gone (#1561). Applied per window, after
 * the window is chosen: a deleted file's rows must not change which runs are in
 * it.
 */
export function applyRetirement<R extends SignalRun & WindowedRun>(
  windows: SuiteWindow<R>[],
  inventory: InventoryInput,
  tree: WorkingTree | null,
): { windows: SuiteWindow<R>[]; retirement: FlakinessRetirement } {
  const live = liveFilesOf(inventory);
  if ('reason' in live) {
    return { windows, retirement: notApplied(live.reason) };
  }
  if (tree === null) {
    return {
      windows,
      retirement: notApplied('the working tree was not checked'),
    };
  }
  const onDisk = onDiskIn(tree);
  const retirement = { ...notApplied(''), applied: true, reason: null };
  const left = windows.map(({ suite, runs }) => {
    const r = retireDeletedFiles(runs, live, onDisk);
    retirement.retired.push(...r.retired.map((t) => ({ suite, ...t })));
    retirement.kept.push(...r.kept.map((k) => ({ suite, ...k })));
    retirement.title_matches.push(
      ...r.titleMatches.map((m) => ({ suite, ...m })),
    );
    retirement.unmatched_rows += r.unmatchedRows;
    return { suite, runs: r.runs };
  });
  retirement.retired.sort((a, b) => b.rate - a.rate);
  retirement.retired_count = retirement.retired.length;
  return { windows: left, retirement };
}
