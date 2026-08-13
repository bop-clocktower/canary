/**
 * CLI subcommands for `canary history` -- faithful port of
 * `agent/history/cli.py` (the `history_app` Typer sub-app), wired to the
 * already-ported async history store (`store.ts` / `schema.ts` / `record.ts`).
 *
 * Follows the guardian CLI conventions (see `../cli-common.ts`): a
 * {@link createHistoryCommand} factory wired to an injectable {@link HistoryDeps}
 * (out/err sinks, env, a store factory), `CliExitError` for business exits, and
 * `normalizeUsageExit` on every command so usage errors exit 2.
 *
 * Python->TS fidelity notes:
 *   - `json.dumps(x, indent=2)` -> {@link jsonIndent2} (byte-exact + ensure_ascii).
 *   - `rich.print("[green]x[/green]")` -> `pc.green('x')`; picocolors strips color
 *     on a non-TTY sink, so the plain text is byte-identical to rich's markup
 *     stripping. Load-bearing glyphs (em-dash, >=) are `\u{...}` escapes.
 *   - The store query methods are ASYNC (the JS Supabase SDK is Promise-based),
 *     so every handler that queries is `async` and awaited.
 *   - INTENTIONAL DEVIATION: `flaky` and `timeline` render with `rich.Table`
 *     (box-drawing). Reproducing rich's exact box bytes is brittle and there is
 *     no Python CLI test pinning them, so this port emits a simple aligned text
 *     table carrying the SAME cell content. `summary`/`push`/`migrate` are NOT
 *     tables and are reproduced byte-for-byte via picocolors stripping.
 *
 * `record` is NOT a port. It has no Python counterpart: nothing in either engine
 * ever wrote the local store, which is why the whole `analyze` / `history`
 * surface had only ever been exercised against synthetic fixtures (#538). Its
 * conversion half lives in `run-recorder.ts`; it takes the async store contract
 * per ADR 0013, so it writes local NDJSON or the remote store by configuration.
 */

import { existsSync, readFileSync } from 'node:fs';

import { Command, Option } from 'commander';
import pc from 'picocolors';

import {
  CliExitError,
  jsonIndent2,
  normalizeUsageExit,
} from '../cli-common.js';
import { gateOutcome } from '../core/gate-result.js';
import type { RunInput, TestResultInput } from './schema.js';
import { makeRunId } from './schema.js';
import { makeStore as realMakeStore, type AsyncHistoryStore } from './store.js';
import {
  buildRunFromVitestReport,
  countReportResults,
  detectReportShape,
  RecordValidationError,
  type BuiltRun,
  type RecordContext,
} from './run-recorder.js';
import { def } from '../util/coalesce.js';
import { pyFloat } from '../util/round.js';

const EM_DASH = '\u{2014}';
const GEQ = '\u{2265}';
const MDASH_CELL = '\u{2014}'; // rich `r.get("area") or <em-dash>`

const DEFAULT_HISTORY_FILE = 'test-results/reports/history-v2.jsonl';

/**
 * The denominator guard for the history reports (#508 Wave 4a).
 *
 * `countRuns` is OPTIONAL on `AsyncHistoryStore`: a backend that cannot report
 * how many runs it holds (today, the remote Supabase store) keeps
 * benefit-of-the-doubt and never abstains. An UNKNOWN denominator is not a zero
 * one -- inventing an abstention would be its own dishonesty, the same reason
 * #527 renders `precision: null` rather than 0.
 *
 * Advisory (D3): exit stays 0. Returns true when the caller should stop.
 */
async function abstainOnEmptyHistory(
  store: AsyncHistoryStore,
  deps: HistoryDeps,
  json: boolean,
  what: string,
): Promise<boolean> {
  if (store.countRuns === undefined) return false; // unknown, not zero
  if ((await store.countRuns()) > 0) return false;
  const outcome = gateOutcome({ checked: 0, findings: [] }, 'advisory');
  const notice =
    `${outcome.summaryLine} No runs recorded, so ${what} is unknown rather ` +
    `than clean. Record runs first (\`canary history push\`), then re-run.`;
  if (json) {
    deps.out(jsonIndent2([]));
    deps.err(notice);
  } else {
    deps.out(notice);
  }
  return true;
}

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

/** Injected outside-world seams (out/err sinks, env, store factory). */
export interface HistoryDeps {
  out(s: string): void;
  err(s: string): void;
  env: NodeJS.ProcessEnv;
  makeStore(dbUrl?: string, ndjsonPath?: string): AsyncHistoryStore;
}

/** Process-backed defaults for production. */
function defaultHistoryDeps(): HistoryDeps {
  return {
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
    env: process.env,
    makeStore: (dbUrl, ndjsonPath) => realMakeStore(dbUrl, ndjsonPath),
  };
}

// --- a minimal aligned text table (documented rich.Table deviation) ----------

function renderTable(
  title: string,
  headers: string[],
  rows: string[][],
  rightAlign: boolean[],
): string[] {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i]!.length)),
  );
  const pad = (cell: string, i: number): string =>
    rightAlign[i] ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!);
  const fmt = (cells: string[]): string =>
    cells.map((c, i) => pad(c, i)).join('  ');
  const lines = [title, fmt(headers)];
  lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) lines.push(fmt(r));
  return lines;
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

// --- record ------------------------------------------------------------------

interface RecordOptions {
  suite: string;
  repo?: string;
  branch?: string;
  commit?: string;
  path?: string;
  runId?: string;
  dbUrl?: string;
  dryRun?: boolean;
  json?: boolean;
}

/** The `flaky: 0` caveat, printed rather than buried in a source comment. */
const FLAKY_VOCABULARY_NOTE =
  'note: flaky=0 \u{2014} vitest reports no flaky status, so a test that was ' +
  'retried and then passed is recorded as passed.';

/** Read + parse the results file, or exit 1 having said which and why. */
function readReport(resultsFile: string, deps: HistoryDeps): unknown {
  if (!existsSync(resultsFile)) {
    deps.out(`${pc.red('Not found:')} ${resultsFile}`);
    throw new CliExitError(1);
  }
  try {
    return JSON.parse(readFileSync(resultsFile, 'utf-8'));
  } catch (err) {
    // Loud, not silent: an unreadable report means this run recorded NOTHING,
    // and a later `analyze` would abstain without ever saying why.
    deps.out(
      `${pc.red('Could not be read:')} ${resultsFile} ` +
        `(${(err as Error).message}) \u{2014} nothing was recorded.`,
    );
    throw new CliExitError(1);
  }
}

/** The repo slug, or exit 2 -- never a hardcoded default (see #538). */
function resolveRepo(opts: RecordOptions, deps: HistoryDeps): string {
  const repo = def(opts.repo, deps.env['GITHUB_REPOSITORY']);
  if (repo) return repo;
  // A hardcoded default repo slug is how a tool ends up filing one team's runs
  // under another team's name. Usage error (exit 2), not a guess.
  deps.out(
    `${pc.red('Missing --repo:')} the repo slug could not be inferred ` +
      `(no GITHUB_REPOSITORY in the environment). Pass ` +
      `--repo <owner>/<name>.`,
  );
  throw new CliExitError(2);
}

/**
 * Resolve the run-level facts a runner's report cannot carry.
 *
 * Fallbacks go through `def()` rather than `??` chains: as a call it is not a
 * decision point, which keeps this mapper under the arch gate's per-function
 * complexity threshold (the same reason the store's row mappers use it).
 */
function recordContext(opts: RecordOptions, deps: HistoryDeps): RecordContext {
  const runId = opts.runId;
  return {
    suite: opts.suite,
    repo: resolveRepo(opts, deps),
    branch: def(opts.branch, def(deps.env['GITHUB_REF_NAME'], 'local')),
    commitSha: def(opts.commit, def(deps.env['GITHUB_SHA'], 'local')),
    // `exactOptionalPropertyTypes`: an absent --run-id omits the key rather
    // than setting it to undefined.
    ...(runId === undefined ? {} : { runId }),
    nowMs: Date.now(),
  };
}

/**
 * `record` is a GATE (ADR 0009): a zero-result report exits 3, because the
 * caller is a CI step whose next command reads the store, and "the suite
 * reported nothing" must not look like "the suite passed". #538.
 */
async function recordCmd(
  resultsFile: string,
  opts: RecordOptions,
  deps: HistoryDeps,
): Promise<void> {
  const parsed = readReport(resultsFile, deps);
  if (detectReportShape(parsed) !== 'vitest') {
    deps.out(
      `${pc.red('Unrecognized report:')} ${resultsFile} carries no ` +
        `\`testResults\` array, so it is not a vitest --reporter=json report. ` +
        `\`record\` reads vitest JSON today; Playwright JSON and JUnit XML ` +
        `are not supported yet.`,
    );
    throw new CliExitError(1);
  }

  // The denominator first: a report with no results is an abstention whatever
  // else is missing, and refusing it over an unresolvable --repo would report
  // the wrong finding.
  if (countReportResults(parsed) === 0) {
    abstainOnEmptyReport(resultsFile, opts, deps);
    return;
  }

  const ctx = recordContext(opts, deps);
  let built;
  try {
    built = buildRunFromVitestReport(parsed, ctx);
  } catch (err) {
    if (!(err instanceof RecordValidationError)) throw err;
    deps.out(
      `${pc.red('Invalid results:')} ${err.message}. Nothing was recorded ` +
        `\u{2014} a malformed record degrades every later read of the store.`,
    );
    throw new CliExitError(1);
  }

  const remote = opts.dbUrl ?? deps.env['CANARY_HISTORY_DB_URL'];
  const storePath = opts.path ?? DEFAULT_HISTORY_FILE;
  const target = remote ? 'the configured remote store' : storePath;

  if (opts.dryRun) {
    reportDryRun(built, target, opts, deps);
    return;
  }

  if (remote && opts.path) {
    deps.err(
      `note: --path is ignored while a db-url is configured; the run goes to ` +
        `the remote store.`,
    );
  }

  const store = deps.makeStore(opts.dbUrl, storePath);
  const before = store.countRuns ? await store.countRuns() : null;
  await store.pushRun(built.run, built.results);
  const after = store.countRuns ? await store.countRuns() : null;

  // `pushRun` skips a duplicate run_id SILENTLY (it is idempotent by design).
  // For a CLI that is the wrong default: the caller believes it recorded a run.
  if (before !== null && after === before) {
    deps.out(
      `${pc.yellow('Already recorded:')} run_id ` +
        `${pc.bold(built.run.run_id)} is already present in ${target}; ` +
        `nothing was appended. Two runs of one suite at one commit inside the ` +
        `same second collide \u{2014} pass --run-id to record a distinct run.`,
    );
    throw new CliExitError(1);
  }
  if (before === null) {
    // Cannot verify is a finding, not a silence (#508).
    deps.err(
      `note: this backend cannot report how many runs it holds, so a ` +
        `duplicate run_id could not be verified \u{2014} the store skips ` +
        `duplicates silently.`,
    );
  }

  reportRecorded(built, target, opts, deps);
}

function abstainOnEmptyReport(
  resultsFile: string,
  opts: RecordOptions,
  deps: HistoryDeps,
): void {
  const outcome = gateOutcome({ checked: 0, findings: [] }, 'gate');
  const notice =
    `${outcome.summaryLine} ${resultsFile} carried zero test results, so ` +
    `nothing was recorded \u{2014} an empty run is the denominator ` +
    `collapsing, not a passing suite. Check that the runner wrote its report ` +
    `(\`vitest --reporter=json --outputFile=<path>\`) and that the suite ran.`;
  if (opts.json) {
    deps.out(
      jsonIndent2({
        suite: opts.suite,
        checked: 0,
        recorded: false,
        abstained: true,
      }),
    );
    deps.err(notice);
  } else {
    deps.out(notice);
  }
  throw new CliExitError(outcome.exitCode);
}

/** The success payload/line. Shared shape so `--json` cannot drift from it. */
function recordPayload(
  built: BuiltRun,
  target: string,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const { run } = built;
  return {
    run_id: run.run_id,
    suite: run.suite,
    repo: run.repo,
    target,
    checked: built.results.length,
    passed: run.passed,
    failed: run.failed,
    flaky: run.flaky,
    skipped: run.skipped,
    abstained: false,
    ...extra,
  };
}

function countsLine(built: BuiltRun): string {
  const { run } = built;
  return (
    `${built.results.length} result(s) for ${pc.bold(run.suite)} ` +
    `(${run.passed} passed, ${run.failed} failed, ${run.skipped} skipped)`
  );
}

function reportDryRun(
  built: BuiltRun,
  target: string,
  opts: RecordOptions,
  deps: HistoryDeps,
): void {
  if (opts.json) {
    deps.out(
      jsonIndent2(
        recordPayload(built, target, { recorded: false, dry_run: true }),
      ),
    );
    return;
  }
  deps.out(
    `${pc.cyan('dry-run:')} would record ${countsLine(built)} as ` +
      `${pc.bold(built.run.run_id)} \u{2192} ${target}`,
  );
  deps.out(FLAKY_VOCABULARY_NOTE);
}

function reportRecorded(
  built: BuiltRun,
  target: string,
  opts: RecordOptions,
  deps: HistoryDeps,
): void {
  if (opts.json) {
    deps.out(jsonIndent2(recordPayload(built, target, { recorded: true })));
    return;
  }
  deps.out(`${pc.green('Recorded')} ${countsLine(built)} \u{2192} ${target}`);
  deps.out(`run_id: ${built.run.run_id}`);
  deps.out(FLAKY_VOCABULARY_NOTE);
}

// --- flaky -------------------------------------------------------------------

interface FlakyOptions {
  window: number;
  suite?: string;
  minRate: number;
  dbUrl?: string;
  json?: boolean;
}

async function flakyCmd(opts: FlakyOptions, deps: HistoryDeps): Promise<void> {
  const store = deps.makeStore(opts.dbUrl);
  if (
    await abstainOnEmptyHistory(store, deps, opts.json === true, 'flake rate')
  ) {
    return;
  }
  const results = await store.queryFlaky(
    opts.window,
    opts.suite ?? null,
    opts.minRate,
  );

  if (opts.json) {
    deps.out(jsonIndent2(results));
    return;
  }

  if (results.length === 0) {
    deps.out(
      pc.green(
        `No tests above ${pyFloat(opts.minRate)}% flake rate in the last ${opts.window} runs.`,
      ),
    );
    return;
  }

  const rows = results.map((r) => [
    r.test_name,
    r.suite ?? '',
    r.area || MDASH_CELL,
    // pyFloat so a whole-number rate renders `10.0%` like Python str(float),
    // not `10%` (JS number has no int/float distinction).
    `${pyFloat(r.flake_rate_pct)}%`,
    `${r.flake_count}/${r.total_runs}`,
  ]);
  const lines = renderTable(
    `Flaky Tests (window: ${opts.window} runs, threshold: ${GEQ} ${pyFloat(opts.minRate)}%)`,
    ['Test', 'Suite', 'Area', 'Flake %', 'Flake/Total'],
    rows,
    [false, false, false, true, true],
  );
  for (const l of lines) deps.out(l);
}

// --- timeline ----------------------------------------------------------------

interface TimelineOptions {
  dbUrl?: string;
  json?: boolean;
}

async function timelineCmd(
  testName: string,
  opts: TimelineOptions,
  deps: HistoryDeps,
): Promise<void> {
  const store = deps.makeStore(opts.dbUrl);

  // #508 (review-round gap): `No history found for: <test>` rendered
  // IDENTICALLY whether the test genuinely has no runs in a populated store (a
  // real answer) or the store is empty and nothing was examined at all (an
  // absent one). Same runs-vs-rows distinction Wave 4a built `countRuns()` for;
  // `timeline` was missed because #515's audit table never listed it.
  if (
    await abstainOnEmptyHistory(
      store,
      deps,
      opts.json === true,
      `the timeline for ${testName}`,
    )
  ) {
    return;
  }

  const rows = await store.queryTimeline(testName);

  if (opts.json) {
    deps.out(jsonIndent2(rows));
    return;
  }

  if (rows.length === 0) {
    deps.out(`${pc.yellow('No history found for:')} ${testName}`);
    return;
  }

  const dataRows = rows.map((row) => [
    row.run_id ?? '',
    (row.commit_sha ?? '').slice(0, 8),
    (row.timestamp ?? '').slice(0, 19),
    row.status ?? '',
    row.failure_category || MDASH_CELL,
  ]);
  const lines = renderTable(
    `Timeline: ${testName}`,
    ['Run ID', 'Commit', 'Timestamp', 'Status', 'Category'],
    dataRows,
    [false, false, false, false, false],
  );
  for (const l of lines) deps.out(l);
}

// --- summary -----------------------------------------------------------------

interface SummaryOptions {
  runs: number;
  dbUrl?: string;
  json?: boolean;
}

async function summaryCmd(
  suite: string,
  opts: SummaryOptions,
  deps: HistoryDeps,
): Promise<void> {
  const store = deps.makeStore(opts.dbUrl);
  const result = await store.querySummary(suite, opts.runs);

  // #508: a summary over zero runs used to print `avg pass rate: 0.0%` -- a
  // FABRICATED number, not a measured one, and the most misleading shape in the
  // whole audit (0% reads as catastrophe, not as absence). The store's own
  // `total_runs` is the denominator here; no extra probe is needed.
  if ((result.total_runs ?? 0) === 0) {
    const outcome = gateOutcome({ checked: 0, findings: [] }, 'advisory');
    const notice =
      `${outcome.summaryLine} Suite ${suite} has no recorded runs, so its ` +
      `pass rate is unknown -- not 0%. Record runs first ` +
      `(\`canary history push\`), then re-run.`;
    if (opts.json) {
      deps.out(jsonIndent2({ ...result, abstained: true }));
      deps.err(notice);
    } else {
      deps.out(notice);
    }
    return;
  }

  if (opts.json) {
    deps.out(jsonIndent2(result));
    return;
  }

  const total = result.total_runs ?? 0;
  const avg = result.avg_pass_rate ?? 0.0;
  const colorize = avg >= 90 ? pc.green : avg >= 70 ? pc.yellow : pc.red;
  deps.out(
    `Suite ${pc.bold(suite)} ${EM_DASH} last ${total} runs ${EM_DASH} avg pass rate: ${colorize(`${pyFloat(avg)}%`)}`,
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

// --- assembly ----------------------------------------------------------------

/** Build a fresh `history` command wired to `depsInit`. */
export function createHistoryCommand(
  depsInit: Partial<HistoryDeps> = {},
): Command {
  const deps: HistoryDeps = { ...defaultHistoryDeps(), ...depsInit };

  const program = new Command('history');
  program
    .description('Query and manage test run history.')
    .exitOverride(normalizeUsageExit);

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
    .command('record')
    .description(
      'Record a finished test run into the history store (vitest JSON).',
    )
    .argument('<results_file>', "Path to the runner's JSON report.")
    .requiredOption('--suite <suite>', 'Suite name for this run (e.g. e2e).')
    .option('--repo <repo>', 'GitHub repo slug (default: $GITHUB_REPOSITORY).')
    .option('--branch <branch>', 'Branch name (default: $GITHUB_REF_NAME).')
    .option('--commit <sha>', 'Commit SHA (default: $GITHUB_SHA).')
    // No commander default: an explicitly-passed --path has to stay
    // distinguishable from the fallback, so a db-url + --path combination can
    // say that --path is unused instead of silently dropping it.
    .option(
      '--path <store>',
      `Local NDJSON store to append to (default: ${DEFAULT_HISTORY_FILE}).`,
    )
    .option(
      '--run-id <id>',
      'Run id (default: <suite>-<commit[:8]>-<epoch seconds>).',
    )
    .addOption(new Option('--db-url <url>').env('CANARY_HISTORY_DB_URL'))
    .option('--dry-run', 'Show what would be recorded without writing.')
    .option('--json')
    .action(async (resultsFile: string, opts: RecordOptions) => {
      await recordCmd(resultsFile, opts, deps);
    });

  program
    .command('flaky')
    .description('Show tests ranked by flake rate over the rolling window.')
    .addOption(
      new Option('-w, --window <n>', 'Rolling window (number of runs).')
        .default(30)
        .argParser((v) => Number.parseInt(v, 10)),
    )
    .option('-s, --suite <suite>', 'Filter to a specific suite.')
    .addOption(
      new Option('--min-rate <pct>', 'Minimum flake rate % to show.')
        .default(10.0)
        .argParser((v) => Number.parseFloat(v)),
    )
    .addOption(new Option('--db-url <url>').env('CANARY_HISTORY_DB_URL'))
    .option('--json')
    .action(async (opts: FlakyOptions) => {
      await flakyCmd(opts, deps);
    });

  program
    .command('timeline')
    .description('Show the full run history for a specific test.')
    .argument('<test_name>', 'Exact test name to trace.')
    .addOption(new Option('--db-url <url>').env('CANARY_HISTORY_DB_URL'))
    .option('--json')
    .action(async (testName: string, opts: TimelineOptions) => {
      await timelineCmd(testName, opts, deps);
    });

  program
    .command('summary')
    .description('Summarize recent runs for a suite.')
    .argument('<suite>', 'Suite name (e.g. api, e2e_ui).')
    .addOption(
      new Option('-n, --runs <n>', 'Number of most recent runs to summarize.')
        .default(10)
        .argParser((v) => Number.parseInt(v, 10)),
    )
    .addOption(new Option('--db-url <url>').env('CANARY_HISTORY_DB_URL'))
    .option('--json')
    .action(async (suite: string, opts: SummaryOptions) => {
      await summaryCmd(suite, opts, deps);
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

  for (const sub of program.commands) {
    sub.exitOverride(normalizeUsageExit);
  }

  return program;
}

/** The production `history` command (process-backed defaults). */
export const historyCommand: Command = createHistoryCommand();
