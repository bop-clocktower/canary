/**
 * The per-window rule behind flakiness retirement (#1500, #1561): given one
 * suite's runs, the inventory's paths and a working-tree test, which stored
 * test files are gone, which stayed scored and why, and which retired titles
 * still live on in another file. The report shape and the abstentions are in
 * `flake-retirement.ts`. Pure.
 */
import {
  flakeSignals,
  type SignalRun,
  type WindowedRun,
} from './flake-signals.js';
import { baseOf, dirOf, joinerFor, normalizePath } from './stored-paths.js';
import { isCollectedTestFile } from './test-files.js';
import type { WorkingTree } from './working-tree.js';

export interface RetiredTest {
  file: string;
  title: string;
  rate: number;
  axis: string | null;
}

/** Why a file missing from the inventory still scored. */
type KeptReason =
  | 'uncollected-name'
  | 'no-live-sibling'
  | 'mostly-missing-directory'
  | 'ran-after-inventory'
  | 'present-on-disk';

export interface KeptFile {
  file: string;
  why: KeptReason;
}

/**
 * A retired test whose title still has rows from a live file in the same
 * window: what a rename looks like (#1561 F2). The retirement stands -- the
 * old file is gone -- but its history did not move with the title.
 */
export interface TitleMatch {
  file: string;
  title: string;
  live_files: string[];
}

/** True when a stored test file is still in the working tree. */
type OnDisk = (stored: string) => boolean;

/** The inventory's root-relative paths (listed + skipped) and its write time. */
export interface LiveFiles {
  paths: readonly string[];
  generated: string | null;
}

interface RetirementResult<R> {
  runs: R[];
  retired: RetiredTest[];
  kept: KeptFile[];
  titleMatches: TitleMatch[];
  /** Rows with no `test_file`: nothing to join, so they stay scored. */
  unmatchedRows: number;
}

/** Every stored file (raw spelling -> newest timestamp) and the file-less rows. */
function storedFiles(runs: readonly (SignalRun & WindowedRun)[]): {
  newest: Map<string, string>;
  unmatchedRows: number;
} {
  const newest = new Map<string, string>();
  let unmatchedRows = 0;
  const rows = runs.flatMap((run) =>
    (run.tests ?? []).map((t) => ({
      file: t.test_file,
      ts: run.timestamp ?? '',
    })),
  );
  for (const { file, ts } of rows) {
    if (!file) unmatchedRows += 1;
    else if (ts >= (newest.get(file) ?? '')) newest.set(file, ts);
  }
  return { newest, unmatchedRows };
}

/** False when either time is absent or unparseable: no evidence of staleness. */
function ranAfter(ts: string, generated: string | null): boolean {
  return generated !== null && Date.parse(ts) > Date.parse(generated);
}

/** How many of `files` sit in each directory. */
function perDirectory(files: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    const dir = dirOf(normalizePath(file));
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return counts;
}

function isCollected(file: string): boolean {
  return isCollectedTestFile(baseOf(normalizePath(file)));
}

function keptReason(
  file: string,
  newest: string,
  dirs: { live: Map<string, number>; missing: Map<string, number> },
  generated: string | null,
): KeptReason | null {
  if (!isCollected(file)) return 'uncollected-name';
  const dir = dirOf(normalizePath(file));
  const live = dirs.live.get(dir) ?? 0;
  if (live === 0) return 'no-live-sibling';
  if (live < (dirs.missing.get(dir) ?? 0)) return 'mostly-missing-directory';
  return ranAfter(newest, generated) ? 'ran-after-inventory' : null;
}

/** One file's tests with their old scores, scored over that file's rows alone. */
function retiredFrom(file: string, runs: readonly SignalRun[]): RetiredTest[] {
  const own = runs.map((r) => ({
    tests: (r.tests ?? []).filter((t) => t.test_file === file),
  }));
  const signals = flakeSignals(own);
  const titles = new Set(own.flatMap((r) => r.tests.map((t) => t.test_name)));
  return [...titles].map((title) => ({
    file,
    title,
    rate: signals.get(title)?.rate ?? 0,
    axis: signals.get(title)?.axis ?? null,
  }));
}

/** Drop `gone`'s rows, and any run they leave empty (an empty run stays empty). */
function withoutFiles<R extends SignalRun>(
  runs: readonly R[],
  gone: ReadonlySet<string>,
): R[] {
  const out: R[] = [];
  for (const run of runs) {
    const tests = run.tests ?? [];
    const left = tests.filter((t) => !t.test_file || !gone.has(t.test_file));
    if (tests.length === 0 || left.length > 0)
      out.push({ ...run, tests: left });
  }
  return out;
}

/** Each retired test whose title still has rows from a file in `live`. */
function titleMatches(
  runs: readonly SignalRun[],
  retired: readonly RetiredTest[],
  live: ReadonlySet<string>,
): TitleMatch[] {
  const where = new Map<string, Set<string>>();
  for (const t of runs.flatMap((r) => r.tests ?? [])) {
    if (!t.test_file || !live.has(t.test_file)) continue;
    where.set(
      t.test_name,
      (where.get(t.test_name) ?? new Set()).add(t.test_file),
    );
  }
  return retired.flatMap(({ file, title }) => {
    const files = where.get(title);
    return files ? [{ file, title, live_files: [...files].sort() }] : [];
  });
}

/**
 * Retire one suite's rows from files that no longer exist (#1500), before
 * anything tallies them.
 *
 * A row retires only when ALL hold: its file is not in the inventory; its file
 * NAME is one the inventory collects; and another stored file in the same
 * stored directory, in this same window, IS in the inventory. The sibling is
 * what makes "not listed" mean "deleted" without knowing the path base: an
 * inventory scoped to `test/` lists no `src/` file, and without this guard it
 * wrongly retired 170 live rows in 13 live files on canary's own suite. A file
 * that ran after the inventory was written stays too: the inventory is stale
 * about it, and a stale inventory must not turn a new test green.
 *
 * Live siblings must also at least match the missing ones. A suffix join can
 * collide: an inventory of another package with its own `test/shared.test.ts`
 * joined 3 of 61 stored files on real data, and with the sibling guard alone
 * that wrongly retired the other 58. Deletion leaves most of a directory behind.
 *
 * Last, the file must be gone from the working tree too (#1561): every guard
 * above trusts the inventory, and an inventory written on another branch
 * omits files that are on disk, which retired a live flaky test. Asked last,
 * so the disk is walked only when something would otherwise retire. Rows
 * recorded in another checkout (a CI runner's absolute paths) cannot exist as
 * written here, so they are found by the same suffix join, or not at all.
 *
 * The join is deliberately file-level (a title-level one wrongly retired 23% of
 * live rows), and tallying stays keyed by `test_name` (#1350 owns identity). A
 * live file that one of these guards misses is a false fail. The guards do not
 * make a false green impossible: a renamed file's old rows retire while its
 * title lives on, so that is reported as a title match rather than hidden.
 *
 * A run left with no row at all measured nothing that still exists, so it
 * leaves the window rather than padding the sample floor.
 */
export function retireDeletedFiles<R extends SignalRun & WindowedRun>(
  runs: readonly R[],
  live: LiveFiles,
  onDisk: OnDisk,
): RetirementResult<R> {
  const { newest, unmatchedRows } = storedFiles(runs);
  const joins = joinerFor(live.paths);
  const stored = [...newest.keys()];
  const listed = new Set(stored.filter((f) => joins(normalizePath(f))));
  const absent = stored.filter((f) => !listed.has(f));
  const dirs = {
    live: perDirectory(listed),
    missing: perDirectory(absent.filter(isCollected)),
  };
  const kept: KeptFile[] = [];
  const gone = new Set<string>();
  for (const file of absent) {
    const why =
      keptReason(file, newest.get(file)!, dirs, live.generated) ??
      (onDisk(file) ? 'present-on-disk' : null);
    if (why) kept.push({ file, why });
    else gone.add(file);
  }
  const retired = [...gone].flatMap((file) => retiredFrom(file, runs));
  const onDiskKept = kept.filter((k) => k.why === 'present-on-disk');
  const stillLive = new Set([...listed, ...onDiskKept.map((k) => k.file)]);
  return {
    runs: gone.size === 0 ? [...runs] : withoutFiles(runs, gone),
    retired,
    kept,
    titleMatches: titleMatches(runs, retired, stillLive),
    unmatchedRows,
  };
}

/**
 * The working-tree test, walked at most once across every suite: a stored path
 * that exists as written (absolute, or under the root), or that joins a test
 * file on disk the same way it would join the inventory.
 */
export function onDiskIn(tree: WorkingTree): OnDisk {
  let joins: ((stored: string) => boolean) | null = null;
  return (file) => {
    const p = normalizePath(file);
    if (tree.exists(p)) return true;
    joins ??= joinerFor(tree.testFiles());
    return joins(p);
  };
}
