/**
 * The `canary order` ranking core (#460 phase 2): order a suite's test files
 * so the likeliest to fail run first.
 *
 * Pure. Ordering is an optimization, never a filter: the plan is a
 * permutation of the files the runner gave us, checked before it is emitted
 * (`assertPermutation`), so a new file with no history is never dropped.
 *
 * The score is additive and every term prints as a reason (D5):
 *   - history: failures in the last `WINDOW` runs of the suite, each weighted
 *     `DECAY^age` so recent failures count more (only once `COLD_START_RUNS`
 *     runs exist, D6/F7);
 *   - diff: the test file itself changed, or it imports a changed file;
 * with ties broken by faster mean duration, then by path, so the same inputs
 * always give the same order. Weights are starting values (A3).
 */

import type { RunRecord } from '../../history/record.js';

export type OrderMode = 'history+diff' | 'diff-only' | 'declaration';

export interface RankedEntry {
  test_file: string;
  score: number;
  reasons: string[];
}

export interface OrderPlan {
  mode: OrderMode;
  modeReason: string;
  /** Runs of this suite the history term could use: its denominator. */
  historyRuns: number;
  /** Changed files in the diff, or null when no diff was given. */
  changedFiles: number | null;
  /** Every input file exactly once, ranked first, then unranked. */
  entries: RankedEntry[];
  /** Files with no signal, in declaration order (they carry no reasons). */
  unranked: string[];
}

export interface OrderInput {
  suite: string;
  /** Repo-relative test files in the runner's declaration order. */
  files: string[];
  runs: RunRecord[];
  /** Repo-relative changed paths, or null for no diff. */
  changed: string[] | null;
  /** Extension-stripped module path -> test files importing it, or null. */
  imports: Map<string, string[]> | null;
}

const COLD_START_RUNS = 5;
const WINDOW = 20;
const DECAY = 0.9;
const CHANGED_WEIGHT = 1;
const IMPORT_WEIGHT = 0.5;
const FAILING = new Set(['failed', 'flaky']);

export function buildOrderPlan(input: OrderInput): OrderPlan {
  const suiteRuns = input.runs
    .filter((r) => r.suite === input.suite)
    .sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
  const window = suiteRuns.slice(-WINDOW);
  const useHistory = suiteRuns.length >= COLD_START_RUNS;
  const { mode, modeReason } = pickMode(suiteRuns.length, input.changed);

  const signals = new Map<string, RankedEntry>(
    input.files.map((f) => [f, { test_file: f, score: 0, reasons: [] }]),
  );
  if (useHistory) addHistory(signals, window);
  if (input.changed !== null) addDiff(signals, input.changed, input.imports);

  const durations = meanDurations(window);
  const all = [...signals.values()];
  const ranked = all
    .filter((e) => e.score > 0)
    .sort((a, b) => compareRanked(a, b, durations));
  const unranked = all.filter((e) => e.score === 0);
  return {
    mode,
    modeReason,
    historyRuns: suiteRuns.length,
    changedFiles: input.changed === null ? null : input.changed.length,
    entries: [...ranked, ...unranked],
    unranked: unranked.map((e) => e.test_file),
  };
}

function pickMode(
  runs: number,
  changed: string[] | null,
): { mode: OrderMode; modeReason: string } {
  if (runs >= COLD_START_RUNS) {
    const diff = changed === null ? '; no diff given' : '';
    return {
      mode: 'history+diff',
      modeReason: `${runs} runs of history${diff}`,
    };
  }
  const have = `${runs} of ${COLD_START_RUNS} runs needed for history`;
  return changed === null
    ? { mode: 'declaration', modeReason: `${have}; no diff given` }
    : { mode: 'diff-only', modeReason: have };
}

function addHistory(
  signals: Map<string, RankedEntry>,
  window: RunRecord[],
): void {
  const failures = new Map<string, { weight: number; count: number }>();
  window.forEach((run, i) => {
    const age = window.length - 1 - i;
    for (const file of failedFiles(run)) {
      const f = failures.get(file) ?? { weight: 0, count: 0 };
      failures.set(file, {
        weight: f.weight + DECAY ** age,
        count: f.count + 1,
      });
    }
  });
  for (const [file, f] of failures) {
    const entry = signals.get(file);
    if (!entry) continue;
    entry.score += f.weight;
    entry.reasons.push(`failed ${f.count} of last ${window.length} runs`);
  }
}

function failedFiles(run: RunRecord): Set<string> {
  const out = new Set<string>();
  for (const t of run.tests ?? []) {
    if (t.test_file && FAILING.has(t.status)) out.add(t.test_file);
  }
  return out;
}

const stripExt = (p: string): string => p.replace(/\.[^./]+$/, '');

function addDiff(
  signals: Map<string, RankedEntry>,
  changed: string[],
  imports: Map<string, string[]> | null,
): void {
  for (const path of changed) {
    const self = signals.get(path);
    if (self) {
      self.score += CHANGED_WEIGHT;
      self.reasons.push('changed in diff');
    }
    for (const test of imports?.get(stripExt(path)) ?? []) {
      const entry = signals.get(test);
      if (!entry || entry === self) continue;
      entry.score += IMPORT_WEIGHT;
      entry.reasons.push(`imports ${path} (changed)`);
    }
  }
}

function meanDurations(window: RunRecord[]): Map<string, number> {
  const sums = new Map<string, { total: number; n: number }>();
  for (const run of window) {
    for (const t of run.tests ?? []) {
      if (!t.test_file || typeof t.duration_ms !== 'number') continue;
      const s = sums.get(t.test_file) ?? { total: 0, n: 0 };
      sums.set(t.test_file, { total: s.total + t.duration_ms, n: s.n + 1 });
    }
  }
  return new Map([...sums].map(([f, s]) => [f, s.total / s.n]));
}

function compareRanked(
  a: RankedEntry,
  b: RankedEntry,
  durations: Map<string, number>,
): number {
  if (a.score !== b.score) return b.score - a.score;
  const da = durations.get(a.test_file) ?? Number.POSITIVE_INFINITY;
  const db = durations.get(b.test_file) ?? Number.POSITIVE_INFINITY;
  if (da !== db) return da - db;
  return a.test_file < b.test_file ? -1 : 1;
}

/**
 * Throw unless the plan holds each input file exactly once. A mismatch is a
 * ranker bug; the CLI exits 2 on it rather than emit an order that loses tests.
 */
export function assertPermutation(files: string[], plan: OrderPlan): void {
  const seen = new Set<string>();
  for (const e of plan.entries) {
    if (seen.has(e.test_file)) {
      throw new Error(`order plan has a duplicate entry: ${e.test_file}`);
    }
    seen.add(e.test_file);
  }
  const missing = files.filter((f) => !seen.has(f));
  const extra = [...seen].filter((f) => !files.includes(f));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `order plan is not a permutation: missing [${missing.join(', ')}], extra [${extra.join(', ')}]`,
    );
  }
}
