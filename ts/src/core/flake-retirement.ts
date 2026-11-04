/**
 * Which rows of a flakiness window still count, given the inventory (#1500).
 *
 * `canary ci-ready` scored every test in the run history, so a deleted test kept
 * failing the check until it aged out of the window, on PRs that never touched
 * it. This retires rows from deleted FILES; the rule and its guards are on
 * {@link retireDeletedFiles}. Split out of `flake-signals.ts` and
 * `flakiness-check.ts` to keep each under the perf file-length threshold.
 *
 * Pure: callers pass the windows and the parsed inventory in.
 */
import {
  flakeSignals,
  type SignalRun,
  type SuiteWindow,
  type WindowedRun,
} from './flake-signals.js';
import type { InventoryInput } from './inventory-checks.js';
import { isCollectedTestFile } from './test-files.js';

/** A retired test: `rate` and `axis` are its last score, kept visible (#1500). */
interface RetiredTest {
  file: string;
  title: string;
  rate: number;
  axis: string | null;
}

/** Why a file missing from the inventory still scored. */
type KeptReason =
  'uncollected-name' | 'no-live-sibling' | 'ran-after-inventory';

interface KeptFile {
  file: string;
  why: KeptReason;
}

/** What the inventory says exists, reduced to what retirement needs. */
interface LiveFiles {
  /** Root-relative POSIX paths: listed files plus unreadable (skipped) ones. */
  paths: readonly string[];
  /** When the inventory was written, if it says. */
  generated: string | null;
}

interface RetirementResult<R> {
  runs: R[];
  retired: RetiredTest[];
  kept: KeptFile[];
  /** Rows with no `test_file`: nothing to join, so they stay scored. */
  unmatchedRows: number;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
}

function baseOf(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

function dirOf(p: string): string {
  return p.slice(0, Math.max(p.lastIndexOf('/'), 0));
}

/**
 * Join on a whole-segment path suffix, either way round: the base of a stored
 * path differs by reporter (absolute for vitest, testDir-relative for
 * Playwright) and an inventory's by its root, and neither says what it is.
 */
function pathsJoin(stored: string, listed: string): boolean {
  return (
    stored === listed ||
    stored.endsWith(`/${listed}`) ||
    listed.endsWith(`/${stored}`)
  );
}

/** Join tester over `paths`; only same-named files can join, so index by name. */
function joinerFor(paths: readonly string[]): (stored: string) => boolean {
  const byBase = new Map<string, string[]>();
  for (const raw of paths) {
    const p = normalizePath(raw);
    byBase.set(baseOf(p), [...(byBase.get(baseOf(p)) ?? []), p]);
  }
  return (stored) =>
    (byBase.get(baseOf(stored)) ?? []).some((p) => pathsJoin(stored, p));
}

/** Every stored file (raw spelling -> newest timestamp) and the file-less rows. */
function storedFiles(runs: readonly (SignalRun & WindowedRun)[]): {
  newest: Map<string, string>;
  unmatchedRows: number;
} {
  const newest = new Map<string, string>();
  let unmatchedRows = 0;
  for (const run of runs) {
    const ts = run.timestamp ?? '';
    for (const { test_file: file } of run.tests ?? []) {
      if (!file) unmatchedRows += 1;
      else if (ts >= (newest.get(file) ?? '')) newest.set(file, ts);
    }
  }
  return { newest, unmatchedRows };
}

/** False when either time is absent or unparseable: no evidence of staleness. */
function ranAfter(ts: string, generated: string | null): boolean {
  return generated !== null && Date.parse(ts) > Date.parse(generated);
}

function keptReason(
  file: string,
  newest: string,
  liveDirs: ReadonlySet<string>,
  generated: string | null,
): KeptReason | null {
  const path = normalizePath(file);
  if (!isCollectedTestFile(baseOf(path))) return 'uncollected-name';
  if (!liveDirs.has(dirOf(path))) return 'no-live-sibling';
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
 * The join is deliberately file-level (a title-level one wrongly retired 23% of
 * live rows), and tallying stays keyed by `test_name` (#1350 owns identity).
 * Every miss therefore keeps scoring: a false fail, never a false green.
 *
 * A run left with no row at all measured nothing that still exists, so it
 * leaves the window rather than padding the sample floor.
 */
function retireDeletedFiles<R extends SignalRun & WindowedRun>(
  runs: readonly R[],
  live: LiveFiles,
): RetirementResult<R> {
  const { newest, unmatchedRows } = storedFiles(runs);
  const joins = joinerFor(live.paths);
  const stored = [...newest.keys()];
  const listed = new Set(stored.filter((f) => joins(normalizePath(f))));
  const liveDirs = new Set([...listed].map((f) => dirOf(normalizePath(f))));
  const kept: KeptFile[] = [];
  const gone = new Set<string>();
  for (const file of stored.filter((f) => !listed.has(f))) {
    const why = keptReason(file, newest.get(file)!, liveDirs, live.generated);
    if (why) kept.push({ file, why });
    else gone.add(file);
  }
  return {
    runs: gone.size === 0 ? [...runs] : withoutFiles(runs, gone),
    retired: [...gone].flatMap((file) => retiredFrom(file, runs)),
    kept,
    unmatchedRows,
  };
}

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
    unmatched_rows: 0,
  };
}

/**
 * Retire each suite's rows against the inventory, or score everything and say
 * why not. Applied per window, after the window is chosen: a deleted file's rows
 * must not change which runs are in it.
 */
export function applyRetirement<R extends SignalRun & WindowedRun>(
  windows: SuiteWindow<R>[],
  inventory: InventoryInput,
): { windows: SuiteWindow<R>[]; retirement: FlakinessRetirement } {
  const live = liveFilesOf(inventory);
  if ('reason' in live) {
    return { windows, retirement: notApplied(live.reason) };
  }
  const retirement = { ...notApplied(''), applied: true, reason: null };
  const left = windows.map(({ suite, runs }) => {
    const r = retireDeletedFiles(runs, live);
    retirement.retired.push(...r.retired.map((t) => ({ suite, ...t })));
    retirement.kept.push(...r.kept.map((k) => ({ suite, ...k })));
    retirement.unmatched_rows += r.unmatchedRows;
    return { suite, runs: r.runs };
  });
  retirement.retired.sort((a, b) => b.rate - a.rate);
  retirement.retired_count = retirement.retired.length;
  return { windows: left, retirement };
}

/**
 * The renderers' lines for what stayed scored or could not be judged. A deleted
 * test that keeps scoring is a false fail, and it should be explainable from
 * the output rather than from this module's docs.
 */
export function retirementNotes(r: FlakinessRetirement | null): string[] {
  if (r === null) return [];
  if (!r.applied) {
    return [
      `Flakiness retirement not applied: ${r.reason}; tests from deleted files keep scoring until they age out.`,
    ];
  }
  const notes: string[] = [];
  if (r.unmatched_rows > 0) {
    notes.push(
      `Flakiness retirement: ${r.unmatched_rows} row(s) with no test_file stayed scored; they cannot be matched to a file.`,
    );
  }
  if (r.kept.length > 0) {
    const named = r.kept.map((k) => `${k.file}: ${k.why}`).join(', ');
    notes.push(
      `Flakiness retirement: ${r.kept.length} file(s) missing from the inventory stayed scored (${named}).`,
    );
  }
  return notes;
}
