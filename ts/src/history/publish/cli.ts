/**
 * `canary history push` and `canary history migrate` -- the two subcommands
 * that move already-captured history INTO the remote store.
 *
 * One of the four subcommand-family modules the `history` command root was
 * split into for #1074; see `../cli.ts` for the seam and the rule. They share
 * this module because they share the field filters: both read records written
 * by something else (a local v2 NDJSON file, a v1 aggregate file) and both
 * have to project them onto the Python dataclass shape before pushing.
 *
 * Named `cli.ts` on purpose, following `../retention/cli.ts`: layer binding is
 * by filename (`ts/src/**\/*cli*.ts` is the `cli` layer, first match wins), and
 * this module imports `cli-common`.
 *
 * Python->TS fidelity: `rich.print("[green]x[/green]")` -> `pc.green('x')`;
 * picocolors strips color on a non-TTY sink, so the plain text is
 * byte-identical to rich's markup stripping. Neither command renders a table,
 * so both are reproduced byte-for-byte.
 */

import { existsSync, readFileSync } from 'node:fs';

import { Command, Option } from 'commander';
import pc from 'picocolors';

import { CliExitError, jsonIndent2 } from '../../cli-common.js';
import { gateOutcome } from '../../core/gate-result.js';
import { makeRunId, type RunInput, type TestResultInput } from '../schema.js';
import type { HistoryDeps } from '../cli-deps.js';

const DEFAULT_HISTORY_FILE = 'test-results/reports/history-v2.jsonl';

/** Every field of the Python `RunRecord` dataclass (the push/migrate filter). */
const RUN_FIELDS: readonly (keyof RunInput)[] = [
  'run_id',
  'suite',
  'repo',
  'branch',
  'commit_sha',
  'timestamp',
  'total',
  'passed',
  'failed',
  'flaky',
  'skipped',
  'commit_message',
  'env',
  'base_url',
  'duration_ms',
  // Not a Python field: #604's reader stamp, preserved so a pushed record keeps
  // whatever measurability it arrived with.
  'reporter_format',
];

/** Every field of the Python `TestResult` dataclass. */
const RESULT_FIELDS: readonly (keyof TestResultInput)[] = [
  'run_id',
  'suite',
  'repo',
  'test_name',
  'test_file',
  'status',
  'area',
  'failure_category',
  'error_text',
  'retry_count',
  'duration_ms',
  'tags',
];

function pick<T>(
  src: Record<string, unknown>,
  fields: readonly (keyof T)[],
): T {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(src, f as string)) {
      out[f as string] = src[f as string];
    }
  }
  return out as T;
}

// --- push --------------------------------------------------------------------

interface PushOptions {
  dbUrl?: string;
  dryRun?: boolean;
}

async function pushCmd(
  historyFile: string,
  opts: PushOptions,
  deps: HistoryDeps,
): Promise<void> {
  if (!existsSync(historyFile)) {
    deps.out(`${pc.red('Not found:')} ${historyFile}`);
    throw new CliExitError(1);
  }

  const store = deps.makeStore(opts.dbUrl, historyFile);

  const records: Record<string, unknown>[] = [];
  for (const raw of readFileSync(historyFile, 'utf-8').split('\n')) {
    const line = raw.trim();
    if (line) records.push(JSON.parse(line) as Record<string, unknown>);
  }

  if (records.length === 0) {
    deps.out(pc.yellow('No runs found in history file.'));
    throw new CliExitError(0);
  }

  const latest = { ...records[records.length - 1]! };
  const testsRaw = (latest['tests'] as Record<string, unknown>[]) ?? [];
  delete latest['tests'];

  const run = pick<RunInput>(latest, RUN_FIELDS);
  const results = testsRaw.map((t) => pick<TestResultInput>(t, RESULT_FIELDS));

  if (opts.dryRun) {
    deps.out(
      `${pc.cyan('dry-run:')} would push run ${pc.bold(run.run_id)} (${results.length} tests)`,
    );
    throw new CliExitError(0);
  }

  await store.pushRun(run, results);
  deps.out(
    `${pc.green('Pushed')} run ${pc.bold(run.run_id)} (${results.length} tests)`,
  );
}

// --- migrate -----------------------------------------------------------------

interface MigrateOptions {
  suite: string;
  repo: string;
  dbUrl?: string;
  dryRun?: boolean;
}

async function migrateCmd(
  file: string,
  opts: MigrateOptions,
  deps: HistoryDeps,
): Promise<void> {
  if (!existsSync(file)) {
    deps.out(`${pc.red('Not found:')} ${file}`);
    throw new CliExitError(1);
  }

  const store = deps.makeStore(opts.dbUrl);
  let migrated = 0;
  const skipped = 0;

  for (const raw of readFileSync(file, 'utf-8').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // JSONDecodeError -> skip (Python does NOT bump `skipped`)
    }

    const commit = (entry['commit_short'] as string) ?? 'unknown';
    const tsStr = (entry['timestamp'] as string) ?? '';
    let ts = 0;
    const parsed = Date.parse(tsStr.replace('Z', '+00:00'));
    if (!Number.isNaN(parsed)) ts = Math.floor(parsed / 1000);

    const runAgg = (entry['run'] as Record<string, number>) ?? {};
    const run: RunInput = {
      run_id: makeRunId(
        opts.suite,
        commit,
        ts || Math.floor(Date.now() / 1000),
      ),
      suite: opts.suite,
      repo: opts.repo,
      branch: (entry['branch'] as string) ?? 'unknown',
      commit_sha: commit,
      timestamp: tsStr,
      total: runAgg['total'] ?? 0,
      passed: runAgg['passed'] ?? 0,
      failed: runAgg['failed'] ?? 0,
      flaky: runAgg['flaky'] ?? 0,
      skipped: runAgg['skipped'] ?? 0,
    };

    if (opts.dryRun) {
      deps.out(`${pc.cyan('dry-run:')} ${run.run_id}`);
      migrated += 1;
      continue;
    }

    await store.pushRun(run, []);
    migrated += 1;
  }

  // #508: `Migrated 0 runs` in green is a success line over an empty
  // denominator -- the #504 shape. A file that yielded nothing was not migrated.
  if (migrated === 0) {
    const outcome = gateOutcome({ checked: 0, findings: [] }, 'advisory');
    deps.out(
      `${outcome.summaryLine} No run in ${file} could be migrated ` +
        `(skipped ${skipped}). Check that the file is v1 history NDJSON and ` +
        `that --suite/--repo match it.`,
    );
    return;
  }
  deps.out(`${pc.green('Migrated')} ${migrated} runs, skipped ${skipped}`);
}

// --- registration ------------------------------------------------------------

/** Mount `history push` and `history migrate` onto the `history` command. */
export function registerPublishCommands(
  program: Command,
  deps: HistoryDeps,
): void {
  program
    .command('push')
    .description(
      'Push the most recent run from a local history file to the remote store.',
    )
    .argument(
      '[history_file]',
      'Path to local history-v2.jsonl to push to remote store.',
      DEFAULT_HISTORY_FILE,
    )
    .addOption(new Option('--db-url <url>').env('CANARY_HISTORY_DB_URL'))
    .option('--dry-run', 'Show what would be pushed without pushing.')
    .action(async (historyFile: string, opts: PushOptions) => {
      await pushCmd(historyFile, opts, deps);
    });

  program
    .command('migrate')
    .description(
      'Migrate a v1 history.jsonl (aggregate-only) into the v2 store.',
    )
    .argument('<file>', 'Path to history.jsonl (v1 format) to migrate.')
    .requiredOption('--suite <suite>', 'Suite name for these records.')
    .requiredOption(
      '--repo <repo>',
      'GitHub repo slug (e.g. acme-corp/api-service).',
    )
    .addOption(new Option('--db-url <url>').env('CANARY_HISTORY_DB_URL'))
    .option('--dry-run')
    .action(async (file: string, opts: MigrateOptions) => {
      await migrateCmd(file, opts, deps);
    });
}
