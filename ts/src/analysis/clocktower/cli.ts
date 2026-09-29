/**
 * `canary history gaps` (#610): which history consumers the store on disk
 * actually feeds, per required field, with denominators.
 *
 * Mounted from `../../commands/engine/cli.ts` (the #988 domain registry, the
 * `history trim` precedent) rather than from `history/cli.ts`, which sits
 * exactly on its arch module-size ceiling and the 15-import perf threshold
 * (#1074). Reads the store only through history's existing exports.
 *
 * Named `cli.ts` on purpose: layer binding is by filename
 * (`ts/src/**\/*cli*.ts` is the `cli` layer, first match wins), and this module
 * imports `cli-common`.
 *
 * Exit contract (core/gate-result.ts, kind `gate`): 0 every measured consumer
 * fed, 1 any dark or partial (or an unreadable store), 3 abstained. A store the
 * reader cannot parse is already loud, so it is an error, not an abstention.
 */
import { existsSync } from 'node:fs';

import type { Command } from 'commander';

import {
  CliExitError,
  jsonIndent2,
  normalizeUsageExit,
} from '../../cli-common.js';
import { gateOutcome, type SkipEntry } from '../../core/gate-result.js';
import { NdjsonHistoryStore } from '../../history/ndjson-store.js';
import type { RunRecord } from '../../history/record.js';
import { CONSUMERS } from './consumers.js';
import { analyzeGaps, type ConsumerGap, type GapReport } from './gaps.js';
import { renderAbstention, renderGapReport } from './render.js';

const DEFAULT_HISTORY_FILE = 'test-results/reports/history-v2.jsonl';
const NOUN = { noun: 'consumer check(s)' };

interface GapsOptions {
  path?: string;
  json?: boolean;
}

/** The sinks + env this command needs (a narrowing of `HistoryDeps`). */
interface GapsDeps {
  out(s: string): void;
  err(s: string): void;
  env: NodeJS.ProcessEnv;
}

/** A remote store this command did not read must still be visible (D8). */
function remoteSkip(env: NodeJS.ProcessEnv): SkipEntry[] {
  return env['CANARY_HISTORY_DB_URL']
    ? [{ name: 'remote store', reason: 'local NDJSON only' }]
    : [];
}

/**
 * The store's records, or null when there is no store at all.
 *
 * `readAll()` returns `[]` for a missing file -- byte-identical to an empty
 * one -- so existence is checked first (D7).
 */
function loadRecords(path: string, deps: GapsDeps): RunRecord[] | null {
  if (!existsSync(path)) return null;
  try {
    return new NdjsonHistoryStore(path).readAll();
  } catch (e) {
    deps.err(`Cannot read ${path}: ${(e as Error).message}`);
    throw new CliExitError(1);
  }
}

function abstain(
  path: string,
  reason: string,
  opts: GapsOptions,
  deps: GapsDeps,
): never {
  const ids = CONSUMERS.map((c) => c.id);
  const skipped = remoteSkip(deps.env);
  const outcome = gateOutcome({ checked: 0, findings: [], skipped }, 'gate');
  deps.out(
    opts.json
      ? jsonIndent2({
          path,
          abstained: true,
          reason,
          runs: 0,
          tests: 0,
          consumers: [],
          darkByAbstention: ids,
          skipped,
          exitCode: outcome.exitCode,
        })
      : `${renderAbstention(reason, ids)}\n\n${outcome.summaryLine}`,
  );
  throw new CliExitError(outcome.exitCode);
}

/**
 * Why a consumer is left out of the denominator, or null when it counts.
 *
 * Unmeasured has no rows to judge. An opt-in consumer that is dark was not
 * asked for: its flag is a choice, not a writer defect, so it is named as
 * skipped rather than failing every store that never used the flag (S4). A
 * partial one was asked for on some runs, so its gaps stay findings.
 */
function skipReason(gap: ConsumerGap): string | null {
  if (gap.status === 'unmeasured') return 'no applicable rows';
  if (gap.optIn !== undefined && gap.status === 'dark') {
    return `opt-in: not recorded with history record ${gap.optIn}`;
  }
  return null;
}

/** Measured consumers are the denominator; the rest render as skipped. */
function outcomeOf(report: GapReport, env: NodeJS.ProcessEnv) {
  const skipped: SkipEntry[] = [];
  const counted: ConsumerGap[] = [];
  for (const gap of report.consumers) {
    const reason = skipReason(gap);
    if (reason === null) counted.push(gap);
    else skipped.push({ name: gap.id, reason });
  }
  skipped.push(...remoteSkip(env));
  const findings = counted.filter((c) => c.status !== 'fed');
  const result = { checked: counted.length, findings, skipped };
  return { skipped, outcome: gateOutcome(result, 'gate', NOUN) };
}

function gapsCmd(opts: GapsOptions, deps: GapsDeps): void {
  const path = opts.path ?? DEFAULT_HISTORY_FILE;
  const records = loadRecords(path, deps);
  if (records === null) abstain(path, `store not found: ${path}`, opts, deps);
  if (records.length === 0) {
    abstain(path, `store is empty: ${path} (0 runs)`, opts, deps);
  }
  const report = analyzeGaps(records);
  const { skipped, outcome } = outcomeOf(report, deps.env);
  deps.out(
    opts.json
      ? jsonIndent2({
          path,
          abstained: outcome.abstained,
          ...report,
          skipped,
          exitCode: outcome.exitCode,
        })
      : `${renderGapReport(report, { path })}\n\n${outcome.summaryLine}`,
  );
  if (outcome.exitCode !== 0) throw new CliExitError(outcome.exitCode);
}

/** Attach `gaps` to the `history` command. */
export function registerGapsCommand(program: Command, deps: GapsDeps): void {
  const gaps = program
    .command('gaps')
    .description(
      'Report which history consumers the local store feeds, per field.',
    )
    .option(
      '--path <store>',
      `Local NDJSON store to read (default: ${DEFAULT_HISTORY_FILE}).`,
    )
    .option('--json')
    .action((opts: GapsOptions) => {
      gapsCmd(opts, deps);
    });
  // Usage errors exit 2, not 1. Commander copies the parent's exit override
  // onto a subcommand created after it, but this module does not control when
  // it is registered, so it opts in itself (as history/retention/cli.ts does).
  gaps.exitOverride(normalizeUsageExit);
}
