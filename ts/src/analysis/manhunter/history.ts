/**
 * Run-history section (#611): the latest run of every suite, plus the flaky
 * and alternating tests over a window, read through the store's own reader.
 *
 * The denominator is the number of stored runs. Zero runs is DARK -- an empty
 * store and a clean one are different facts (`countRuns`, #508) -- and a
 * corrupt or future-version store is DARK with the store's own error rather
 * than read as empty.
 */

import { NdjsonHistoryStore } from '../../history/ndjson-store.js';
import type { RunRecord } from '../../history/record.js';
import { readSource, sourceRef } from './sources.js';
import { darkSection, fedSection, type Section } from './types.js';

/** Same threshold `canary analyze flaky` and `ci-ready` use: 10%. */
const FLAKY_MIN_RATE_PCT = 10;

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** The newest run per suite, by timestamp (append order breaks ties). */
function latestPerSuite(runs: RunRecord[]): RunRecord[] {
  const latest = new Map<string, RunRecord>();
  for (const run of runs) {
    const prev = latest.get(run.suite);
    if (!prev || (run.timestamp ?? '') >= (prev.timestamp ?? '')) {
      latest.set(run.suite, run);
    }
  }
  return [...latest.values()];
}

function runFact(run: RunRecord): string {
  const [passed, failed, flaky, total] = [
    run.passed,
    run.failed,
    run.flaky,
    run.total,
  ].map((v) => v ?? 0);
  return (
    `suite ${run.suite}: latest run ${run.run_id} (${run.timestamp ?? 'no timestamp'}): ` +
    `${passed} passed, ${failed} failed, ${flaky} flaky of ${total}`
  );
}

/** The stored runs, or why the store cannot feed the section. */
function unusableStore(
  path: string,
  store: NdjsonHistoryStore,
): string | RunRecord[] {
  let runs: RunRecord[];
  try {
    runs = store.readAll();
  } catch (err) {
    return `${path} could not be read (${(err as Error).message})`;
  }
  if (!runs.some((r) => (r.total ?? 0) > 0)) {
    return `${path} holds ${plural(runs.length, 'run')} and none executed a test, so there is no run history to report`;
  }
  return runs;
}

function failingEye(r: RunRecord): string {
  return `suite ${r.suite}: latest run ${r.run_id} has ${r.failed ?? 0} failed of ${plural(r.total ?? 0, 'test')}`;
}

export function historySection(path: string, windowRuns: number): Section {
  const read = readSource(path);
  const ref = sourceRef(read);
  if (read.kind === 'missing') {
    return darkSection('run-history', [ref], `no run-history store at ${path}`);
  }
  const store = new NdjsonHistoryStore(path);
  const runs = unusableStore(path, store);
  if (typeof runs === 'string') return darkSection('run-history', [ref], runs);
  const latest = latestPerSuite(runs);
  const flaky = store.queryFlaky(windowRuns, null, FLAKY_MIN_RATE_PCT);
  return fedSection('run-history', {
    sources: [ref],
    denominator: `${plural(runs.length, 'run')} across ${plural(latest.length, 'suite')}`,
    facts: [
      ...latest.map(runFact),
      `${plural(flaky.length, 'flaky or alternating test')} over the last ${windowRuns} runs`,
    ],
    eyes: [
      ...latest.filter((r) => (r.failed ?? 0) > 0).map(failingEye),
      ...flaky.map(
        (f) =>
          `flaky: ${f.test_name} (${f.suite}) ${f.flake_rate_pct}% over ${plural(f.total_runs, 'run')}`,
      ),
    ],
  });
}
