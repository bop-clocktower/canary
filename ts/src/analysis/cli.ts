/**
 * CLI subcommands for `canary analyze` -- faithful port of
 * `agent/analysis/cli.py` (the `analyze_app` Typer sub-app), wired to the
 * already-ported analysis engine + report builders (`engine.ts`, `reports.ts`,
 * `rows.ts`) and the local NDJSON history store.
 *
 * Follows the guardian CLI conventions (see `../cli-common.ts`): a
 * {@link createAnalyzeCommand} factory wired to an injectable {@link AnalyzeDeps},
 * and `normalizeUsageExit` on every command so usage errors exit 2. No command
 * raises a business exit -- every analyze subcommand returns 0 (matching Python).
 *
 * Python->TS fidelity notes:
 *   - `json.dumps(x, indent=2)` -> {@link jsonIndent2} (byte-exact + ensure_ascii).
 *   - The report builders are byte-exact ports (Markdown), so the human-readable
 *     paths match the oracle exactly.
 *   - `--db-url` / `CANARY_HISTORY_DB_URL` are HONOURED as of #711 (ADR 0013
 *     Decision 4): the engine is async, so analyze selects its backend through
 *     the shared `makeStore` factory like every other history consumer. Three
 *     reports (spikes, common-failures, regression-candidates) are computed by
 *     walking raw run records, which only the local backend exposes; against a
 *     remote backend each names itself as unverifiable instead of rendering an
 *     empty report. No Python analyze test exercised a remote store.
 *   - `area-health` accepts `--json` but ignores it -- faithful to the Python
 *     command, which never branches on `output_json`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Command, InvalidArgumentError, Option } from 'commander';

import { jsonIndent2, normalizeUsageExit } from '../cli-common.js';
import { gateOutcome } from '../core/gate-result.js';
import { AnalysisEngine } from './engine.js';
import {
  buildCommonFailuresReport,
  buildFlakyTestsReport,
  buildRegressionCandidatesReport,
  buildFailureSpikesReport,
} from './reports.js';
import type { AsyncHistoryStore } from '../history/async-store.js';
import { makeStore } from '../history/store.js';

const DEFAULT_HISTORY_PATH = 'test-results/reports/history-v2.jsonl';

/** Injected outside-world seams (out sink, env, store factory). */
export interface AnalyzeDeps {
  out(s: string): void;
  err(s: string): void;
  env: NodeJS.ProcessEnv;
  makeStore(dbUrl?: string): AsyncHistoryStore;
}

/** Process-backed defaults for production. */
export function defaultAnalyzeDeps(): AnalyzeDeps {
  return {
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
    env: process.env,
    // #711: analyze now goes through the shared factory, so --db-url and
    // CANARY_HISTORY_DB_URL select the backend for real. Until the engine went
    // async this could not be done -- the engine held the synchronous store
    // contract -- and the flag was accepted with a printed apology instead.
    // Where a remote backend cannot answer a given section, the command says so
    // by name (see `cannotVerifyRawRecords`) rather than rendering an empty one.
    makeStore: (dbUrl?: string) => makeStore(dbUrl, DEFAULT_HISTORY_PATH),
  };
}

/**
 * The shared denominator guard for every history-backed analyze report
 * (#508 Wave 4a).
 *
 * The denominator is the number of RUNS in the store, never the number of
 * result rows: zero flaky rows across 500 runs is a genuine clean fleet, while
 * zero rows across zero runs is an absent measurement. Only `countRuns()`
 * separates them -- keying off `rows.length` would abstain on every healthy
 * fleet, which is the fastest way to get a doctrine muted (the katana lesson).
 *
 * Advisory (D3): the exit stays 0. On the human path the abstention line
 * REPLACES the all-clear report; on `--json` the payload is a bare array with
 * nowhere to put an `abstained` field, so stdout is left byte-identical and the
 * notice rides stderr -- the same split `analyze` already uses for its
 * `--db-url` note.
 *
 * Returns true when the caller should stop (the store was empty).
 */
async function abstainOnEmptyHistory(
  store: AsyncHistoryStore,
  deps: AnalyzeDeps,
  json: boolean,
  what: string,
): Promise<boolean> {
  // #711: `countRuns` is an OPTIONAL capability, and a backend that cannot
  // report its denominator has an UNKNOWN one, not a zero one (ADR 0013
  // Decision 3). Abstaining here would fire on every remote query and mute the
  // doctrine -- the katana lesson again, from the other direction.
  if (!store.countRuns) return false;
  if ((await store.countRuns()) > 0) return false;
  const outcome = gateOutcome({ checked: 0, findings: [] }, 'advisory');
  const notice =
    `${outcome.summaryLine} No run history to analyze, so "${what}" is ` +
    `unknown rather than clean. Record runs first ` +
    `(\`canary history push\`, or a reporter that writes ` +
    `${DEFAULT_HISTORY_PATH}), then re-run.`;
  if (json) {
    deps.out(jsonIndent2([]));
    deps.err(notice);
  } else {
    deps.out(notice);
  }
  return true;
}

/**
 * The capability guard for the sections built on raw run records (#711).
 *
 * `spikes`, `common-failures` and `regression-candidates` are computed by
 * walking whole run records rather than by any aggregate query, so they exist
 * only where the backend implements the optional `readAll()`. The local NDJSON
 * store does; the remote Supabase store does not.
 *
 * Against a backend without it these commands used to emit an empty report,
 * which is indistinguishable on screen from a measured all-clear — the exact
 * false-green shape #508 exists to kill, and one that only became reachable
 * once `--db-url` started being honoured. So the command names the section it
 * could not compute, and names the ones that DO work against this backend so
 * the answer is actionable rather than just a refusal.
 *
 * Advisory, matching `abstainOnEmptyHistory`: the exit stays 0, the human path
 * gets the notice instead of the report, and `--json` keeps stdout a parseable
 * empty array with the notice on stderr.
 *
 * Returns true when the caller should stop.
 */
function cannotVerifyRawRecords(
  store: AsyncHistoryStore,
  deps: AnalyzeDeps,
  json: boolean,
  what: string,
): boolean {
  if (store.readAll) return false;
  const outcome = gateOutcome({ checked: 0, findings: [] }, 'advisory');
  const notice =
    `${outcome.summaryLine} cannot verify: this history backend does not ` +
    `expose raw run records, so "${what}" is UNKNOWN rather than clean. ` +
    `\`analyze flaky\` works against this backend today; drop --db-url ` +
    `(and CANARY_HISTORY_DB_URL) to analyze the local ${DEFAULT_HISTORY_PATH} ` +
    `instead.`;
  if (json) {
    deps.out(jsonIndent2([]));
    deps.err(notice);
  } else {
    deps.out(notice);
  }
  return true;
}

// --- unit-bearing flags (#673) -----------------------------------------------
//
// #670 put the unit in the NAME one layer down -- `analysis/reports.ts` takes
// `windowRuns`, `deltaPp`, `minRatePct` -- and stopped at the CLI boundary
// because renaming a flag is user-visible. The flags carried the same silence
// they always had: the report prints `window: 30 runs`, `20.0pp increase` and
// `>= 10.0%`, so the unit only ever arrived AFTER the user had guessed. This
// section closes that gap using the same convention: `<measure><Unit>` in
// camelCase becomes `--<measure>-<unit>` on the command line.
//
// `--delta` is the sharpest case. It is a percentage-POINT threshold that looks
// like a percentage, so `--delta 20` against a failure rate moving 5% -> 6% is
// the difference between firing and staying silent, with nothing on screen to
// say which reading applied.

/** One decimal or integer, no sign: the only shape these thresholds accept. */
const UNSIGNED_NUMBER = /^(\d+(\.\d+)?|\.\d+)$/;

/**
 * A whole count of runs, >= 1.
 *
 * The bare `Number.parseInt` this replaces mapped `--window seven` to `NaN`,
 * which the query layer happily compared against and matched nothing -- a
 * silent abstention wearing a clean fleet's clothes. A value that cannot mean
 * what the flag says is a usage error instead.
 */
function parseRuns(flag: string): (raw: string) => number {
  return (raw) => {
    if (!/^\d+$/.test(raw.trim()) || Number.parseInt(raw, 10) < 1) {
      throw new InvalidArgumentError(
        `${flag} takes a whole number of RUNS, at least 1 (e.g. 30); ` +
          `got "${raw}".`,
      );
    }
    return Number.parseInt(raw, 10);
  };
}

/**
 * A 0-100 value on a percentage scale (`percent` for a rate, `percentage
 * points` for a delta). Rejecting >100 is what catches the fraction habit from
 * the other direction; `0.1` is still legal (a tenth of a percent), so the help
 * text carries that half of the warning.
 */
function parsePercentScale(
  flag: string,
  unit: string,
): (raw: string) => number {
  return (raw) => {
    const n = Number.parseFloat(raw);
    if (!UNSIGNED_NUMBER.test(raw.trim()) || !Number.isFinite(n) || n > 100) {
      throw new InvalidArgumentError(
        `${flag} takes ${unit} between 0 and 100 (e.g. 10 means ten ${unit}, ` +
          `not 0.1); got "${raw}".`,
      );
    }
    return n;
  };
}

/**
 * A pre-#673 flag spelling kept alive as a deprecated alias, paired with the
 * unit-bearing name that replaced it.
 *
 * Keeping the aliases is deliberate: every scripted `canary analyze` invocation
 * in a CI file predates the rename, and a flag that vanishes turns a rename
 * into an outage. The alias warns on stderr (never stdout -- `--json` stays
 * byte-clean, the same split `--db-url` already uses) so the migration is
 * visible without breaking anything.
 */
interface UnitFlagAlias {
  /** Commander attribute for the canonical option (`--window-runs`). */
  canonical: string;
  /** Commander attribute for the deprecated option (`--window`). */
  legacy: string;
  canonicalFlag: string;
  legacyFlag: string;
  /** The unit the value has always carried, stated plainly. */
  unit: string;
}

const WINDOW_ALIAS: UnitFlagAlias = {
  canonical: 'windowRuns',
  legacy: 'window',
  canonicalFlag: '--window-runs',
  legacyFlag: '--window',
  unit: 'a count of runs, not days',
};

const DELTA_ALIAS: UnitFlagAlias = {
  canonical: 'deltaPp',
  legacy: 'delta',
  canonicalFlag: '--delta-pp',
  legacyFlag: '--delta',
  unit: 'percentage points, not percent',
};

const MIN_RATE_ALIAS: UnitFlagAlias = {
  canonical: 'minRatePct',
  legacy: 'minRate',
  canonicalFlag: '--min-rate-pct',
  legacyFlag: '--min-rate',
  unit: 'a percentage, 0-100',
};

/**
 * Fold any deprecated spellings the user typed onto their canonical keys.
 *
 * The canonical flag wins when BOTH are given -- the alias is the legacy path,
 * so an explicit new-style flag is the more deliberate statement of intent.
 * `getOptionValueSource` is what separates "the user typed it" from "commander
 * filled in the default"; comparing values would let a canonical default that
 * happens to equal the alias silently discard the alias.
 */
function resolveUnitFlags<T extends object>(
  opts: T,
  cmd: Command,
  deps: AnalyzeDeps,
  aliases: UnitFlagAlias[],
): T {
  // Commander hands option bags back as plain objects keyed by camelCase flag
  // name; the per-command interfaces describe them but carry no index
  // signature, so the alias keys are reached through one local widening.
  const merged = { ...opts } as unknown as Record<string, unknown>;
  for (const alias of aliases) {
    if (merged[alias.legacy] === undefined) continue;
    deps.err(
      `note: ${alias.legacyFlag} is deprecated; use ${alias.canonicalFlag} ` +
        `(the value is ${alias.unit}).`,
    );
    if (cmd.getOptionValueSource(alias.canonical) !== 'cli') {
      merged[alias.canonical] = merged[alias.legacy];
    }
  }
  return merged as T;
}

function writeArtifacts(
  artifacts: Record<string, string>,
  output: string,
): void {
  mkdirSync(output, { recursive: true });
  for (const [name, content] of Object.entries(artifacts)) {
    writeFileSync(join(output, name), content, 'utf-8');
  }
}

// --- flaky -------------------------------------------------------------------

interface FlakyOptions {
  windowRuns: number;
  suite?: string;
  minRatePct: number;
  /** Deprecated alias for {@link FlakyOptions.windowRuns}. */
  window?: number;
  /** Deprecated alias for {@link FlakyOptions.minRatePct}. */
  minRate?: number;
  dbUrl?: string;
  json?: boolean;
}

async function flakyCmd(opts: FlakyOptions, deps: AnalyzeDeps): Promise<void> {
  const store = deps.makeStore(opts.dbUrl);
  if (
    await abstainOnEmptyHistory(store, deps, opts.json === true, 'flake rate')
  ) {
    return;
  }
  const rows = await store.queryFlaky(
    opts.windowRuns,
    opts.suite ?? null,
    opts.minRatePct,
  );
  if (opts.json) {
    deps.out(jsonIndent2(rows));
  } else {
    deps.out(buildFlakyTestsReport(rows, opts.windowRuns, opts.minRatePct));
  }
}

// --- spikes ------------------------------------------------------------------

interface SpikesOptions {
  since?: string;
  deltaPp: number;
  /** Deprecated alias for {@link SpikesOptions.deltaPp}. */
  delta?: number;
  dbUrl?: string;
  json?: boolean;
}

async function spikesCmd(
  opts: SpikesOptions,
  deps: AnalyzeDeps,
): Promise<void> {
  const store = deps.makeStore(opts.dbUrl);
  if (
    await abstainOnEmptyHistory(
      store,
      deps,
      opts.json === true,
      'failure spikes',
    )
  ) {
    return;
  }
  if (
    cannotVerifyRawRecords(store, deps, opts.json === true, 'failure spikes')
  ) {
    return;
  }
  const rows: {
    suite: string;
    timestamp: string;
    passed: number;
    failed: number;
    flaky: number;
    total: number;
  }[] = [];
  for (const r of await store.readAll!()) {
    if (opts.since && (r.timestamp ?? '') < opts.since) continue;
    rows.push({
      suite: r.suite ?? '',
      timestamp: r.timestamp ?? '',
      passed: r.passed ?? 0,
      failed: r.failed ?? 0,
      flaky: r.flaky ?? 0,
      total: r.total ?? 0,
    });
  }
  if (opts.json) {
    deps.out(jsonIndent2(rows));
  } else {
    deps.out(buildFailureSpikesReport(rows, opts.deltaPp));
  }
}

// --- area-health -------------------------------------------------------------

interface AreaHealthOptions {
  weeks: number;
  dbUrl?: string;
  json?: boolean;
}

function areaHealthCmd(opts: AreaHealthOptions, deps: AnalyzeDeps): void {
  // #508 Wave 4a: this command builds its report from a HARDCODED empty row
  // set (faithful to the Python original, which did the same and never branched
  // on --json). Its denominator is therefore UNCONDITIONALLY zero -- with a
  // thousand runs recorded it still renders "no area health data", which reads
  // as a measured all-clear and is not one. So it always abstains, whatever the
  // store holds. Wiring a real row set is a separate scope call: it changes the
  // port's contract, and #515 deferred it for exactly that reason.
  void opts;
  const outcome = gateOutcome({ checked: 0, findings: [] }, 'advisory');
  deps.out(
    `${outcome.summaryLine} \`analyze area-health\` computes no rows in this ` +
      `build -- its report is a template, not a measurement, so a clean-looking ` +
      `result here would be a fiction. Use \`analyze digest\` for the reports ` +
      `that are wired, and track the area-health row set as unimplemented.`,
  );
}

// --- common-failures ---------------------------------------------------------

interface CommonFailuresOptions {
  since?: string;
  minSuites: number;
  dbUrl?: string;
  json?: boolean;
}

async function commonFailuresCmd(
  opts: CommonFailuresOptions,
  deps: AnalyzeDeps,
): Promise<void> {
  const store = deps.makeStore(opts.dbUrl);
  if (
    await abstainOnEmptyHistory(
      store,
      deps,
      opts.json === true,
      'common failures',
    )
  ) {
    return;
  }
  if (
    cannotVerifyRawRecords(store, deps, opts.json === true, 'common failures')
  ) {
    return;
  }
  const rows: {
    test_name: string;
    suite: string;
    failure_category: string;
    error_text: string;
    run_count: number;
  }[] = [];
  for (const record of await store.readAll!()) {
    if (opts.since && (record.timestamp ?? '') < opts.since) continue;
    for (const t of record.tests ?? []) {
      if ((t.status === 'failed' || t.status === 'flaky') && t.error_text) {
        rows.push({
          test_name: t.test_name,
          suite: record.suite ?? '',
          failure_category: t.failure_category ?? 'other',
          error_text: t.error_text ?? '',
          run_count: 1,
        });
      }
    }
  }
  if (opts.json) {
    deps.out(jsonIndent2(rows));
  } else {
    deps.out(buildCommonFailuresReport(rows, opts.minSuites));
  }
}

// --- regression-candidates ---------------------------------------------------

interface RegressionOptions {
  minGreen: number;
  recentFailures: number;
  dbUrl?: string;
  json?: boolean;
}

async function regressionCandidatesCmd(
  opts: RegressionOptions,
  deps: AnalyzeDeps,
): Promise<void> {
  const store = deps.makeStore(opts.dbUrl);
  if (
    await abstainOnEmptyHistory(
      store,
      deps,
      opts.json === true,
      'regression candidates',
    )
  ) {
    return;
  }
  if (
    cannotVerifyRawRecords(
      store,
      deps,
      opts.json === true,
      'regression candidates',
    )
  ) {
    return;
  }
  const engine = new AnalysisEngine(store);
  const candidates = await engine.detectRegressionCandidates(
    null,
    opts.minGreen,
    opts.recentFailures,
  );
  if (opts.json) {
    deps.out(jsonIndent2(candidates));
  } else {
    deps.out(buildRegressionCandidatesReport(candidates));
  }
}

// --- digest ------------------------------------------------------------------

interface DigestOptions {
  windowRuns: number;
  deltaPp: number;
  /** Deprecated alias for {@link DigestOptions.windowRuns}. */
  window?: number;
  /** Deprecated alias for {@link DigestOptions.deltaPp}. */
  delta?: number;
  weeks: number;
  minSuites: number;
  suite?: string;
  output: string;
  json?: boolean;
  slack?: boolean;
  dbUrl?: string;
}

async function digestCmd(
  opts: DigestOptions,
  deps: AnalyzeDeps,
): Promise<void> {
  const store = deps.makeStore(opts.dbUrl);
  if (
    await abstainOnEmptyHistory(store, deps, opts.json === true, 'fleet health')
  ) {
    return;
  }
  const engine = new AnalysisEngine(store);
  const result = await engine.run({
    windowRuns: opts.windowRuns,
    deltaPp: opts.deltaPp,
    weeks: opts.weeks,
    minSuites: opts.minSuites,
    suite: opts.suite ?? null,
  });
  writeArtifacts(result.artifacts, opts.output);

  // Unlike the single-section commands, digest can partially succeed: the flaky
  // leaderboard rides a contract method and is real even on a backend with no
  // raw-record access. So it renders what it measured and names what it could
  // not -- a digest silently missing three of its five sections would be the
  // worst of both worlds. The notice rides stderr so --json and the Slack path
  // stay byte-clean for their consumers.
  if (result.degraded.length > 0) {
    const outcome = gateOutcome({ checked: 0, findings: [] }, 'advisory');
    deps.err(
      `${outcome.summaryLine} cannot verify: this history backend does not ` +
        `expose raw run records, so ${result.degraded.join(', ')} ` +
        `${result.degraded.length === 1 ? 'is' : 'are'} UNKNOWN rather than ` +
        `clean in this digest. The flake leaderboard above is measured.`,
    );
  }

  if (opts.json) {
    deps.out(
      jsonIndent2({
        flaky_count: result.flaky.length,
        spike_count: result.spikes.length,
        regression_count: result.regressionCandidates.length,
      }),
    );
  } else if (opts.slack) {
    printSlack(result.flaky.length, result.regressionCandidates.length, deps);
  } else {
    deps.out(result.digestMd);
    deps.out(`\nArtifacts written to ${opts.output}/`);
  }
}

function printSlack(
  flakyCount: number,
  regCount: number,
  deps: AnalyzeDeps,
): void {
  // U+2022 bullet, U+2265 >=.
  const lines = [
    '*Fleet Health Digest*',
    `\u{2022} Flakeys \u{2265} 10%: ${flakyCount}`,
    `\u{2022} Regression candidates: ${regCount}`,
  ];
  deps.out(lines.join('\n'));
}

// --- assembly ----------------------------------------------------------------

// Option help shared across subcommands. Every analyze option carries a
// description: a blank one is how the silent unit survived this long, since the
// value's meaning lived only in the report it eventually printed.
const DB_URL_ENV = 'CANARY_HISTORY_DB_URL';
const DB_URL_DESC =
  'History store URL. Defaults to the local NDJSON store; a remote backend ' +
  'cannot answer the spikes, common-failures or regression-candidates ' +
  'reports, which say so rather than reporting zero.';
const JSON_DESC = 'Emit the rows as JSON instead of a Markdown report.';
const WINDOW_RUNS_DESC = 'Rolling window measured in RUNS, not days.';
const MIN_RATE_PCT_DESC =
  'Minimum flake rate to report, in PERCENT 0-100 (10 means 10%, not 0.1).';
const DELTA_PP_DESC =
  'Spike threshold as a PERCENTAGE-POINT rise in failure rate ' +
  '(20 means 5% -> 25%, not 5% -> 6%).';

/** Build a fresh `analyze` command wired to `depsInit`. */
export function createAnalyzeCommand(
  depsInit: Partial<AnalyzeDeps> = {},
): Command {
  const deps: AnalyzeDeps = { ...defaultAnalyzeDeps(), ...depsInit };

  const program = new Command('analyze');
  program
    .description('Cross-suite fleet health analysis.')
    .exitOverride(normalizeUsageExit);

  program
    .command('flaky')
    .description('Fleet-wide flake leaderboard.')
    .addOption(
      new Option('-w, --window-runs <runs>', WINDOW_RUNS_DESC)
        .default(30)
        .argParser(parseRuns('--window-runs')),
    )
    .addOption(
      new Option(
        '--window <runs>',
        'Deprecated alias for --window-runs.',
      ).argParser(parseRuns('--window')),
    )
    .option('-s, --suite <suite>', 'Filter to a specific suite.')
    .addOption(
      new Option('--min-rate-pct <percent>', MIN_RATE_PCT_DESC)
        .default(10.0)
        .argParser(parsePercentScale('--min-rate-pct', 'percent')),
    )
    .addOption(
      new Option(
        '--min-rate <percent>',
        'Deprecated alias for --min-rate-pct.',
      ).argParser(parsePercentScale('--min-rate', 'percent')),
    )
    .addOption(new Option('--db-url <url>', DB_URL_DESC).env(DB_URL_ENV))
    .option('--json', JSON_DESC)
    .action(async (opts: FlakyOptions, cmd: Command) => {
      await flakyCmd(
        resolveUnitFlags(opts, cmd, deps, [WINDOW_ALIAS, MIN_RATE_ALIAS]),
        deps,
      );
    });

  program
    .command('spikes')
    .description('Recent failure spikes across suites.')
    .option('--since <date>', 'ISO date filter, e.g. 2026-06-01')
    .addOption(
      new Option('--delta-pp <points>', DELTA_PP_DESC)
        .default(20.0)
        .argParser(parsePercentScale('--delta-pp', 'percentage points')),
    )
    .addOption(
      new Option(
        '--delta <points>',
        'Deprecated alias for --delta-pp.',
      ).argParser(parsePercentScale('--delta', 'percentage points')),
    )
    .addOption(new Option('--db-url <url>', DB_URL_DESC).env(DB_URL_ENV))
    .option('--json', JSON_DESC)
    .action(async (opts: SpikesOptions, cmd: Command) => {
      await spikesCmd(resolveUnitFlags(opts, cmd, deps, [DELTA_ALIAS]), deps);
    });

  program
    .command('area-health')
    .description('Area degradation trends over time.')
    .addOption(
      new Option('--weeks <weeks>', 'Trend window, in whole weeks.')
        .default(4)
        .argParser((v) => Number.parseInt(v, 10)),
    )
    .addOption(new Option('--db-url <url>', DB_URL_DESC).env(DB_URL_ENV))
    .option('--json', JSON_DESC)
    .action((opts: AreaHealthOptions) => {
      areaHealthCmd(opts, deps);
    });

  program
    .command('common-failures')
    .description('Cross-suite failure fingerprinting.')
    .option('--since <date>', 'ISO date filter, e.g. 2026-06-01')
    .addOption(
      new Option(
        '--min-suites <suites>',
        'Report a failure only once it appears in this many SUITES.',
      )
        .default(2)
        .argParser((v) => Number.parseInt(v, 10)),
    )
    .addOption(new Option('--db-url <url>', DB_URL_DESC).env(DB_URL_ENV))
    .option('--json', JSON_DESC)
    .action(async (opts: CommonFailuresOptions) => {
      await commonFailuresCmd(opts, deps);
    });

  program
    .command('regression-candidates')
    .description('Tests newly and consistently broken after a green streak.')
    .addOption(
      new Option(
        '--min-green <runs>',
        'Length of the prior green streak, in RUNS.',
      )
        .default(5)
        .argParser((v) => Number.parseInt(v, 10)),
    )
    .addOption(
      new Option(
        '--recent-failures <runs>',
        'Consecutive failing RUNS required after the streak.',
      )
        .default(3)
        .argParser((v) => Number.parseInt(v, 10)),
    )
    .addOption(new Option('--db-url <url>', DB_URL_DESC).env(DB_URL_ENV))
    .option('--json', JSON_DESC)
    .action(async (opts: RegressionOptions) => {
      await regressionCandidatesCmd(opts, deps);
    });

  program
    .command('digest')
    .description('Combined digest of all five report types.')
    .addOption(
      new Option('--window-runs <runs>', WINDOW_RUNS_DESC)
        .default(30)
        .argParser(parseRuns('--window-runs')),
    )
    .addOption(
      new Option(
        '--window <runs>',
        'Deprecated alias for --window-runs.',
      ).argParser(parseRuns('--window')),
    )
    .addOption(
      new Option('--delta-pp <points>', DELTA_PP_DESC)
        .default(20.0)
        .argParser(parsePercentScale('--delta-pp', 'percentage points')),
    )
    .addOption(
      new Option(
        '--delta <points>',
        'Deprecated alias for --delta-pp.',
      ).argParser(parsePercentScale('--delta', 'percentage points')),
    )
    .addOption(
      new Option('--weeks <weeks>', 'Area-health trend window, in whole weeks.')
        .default(4)
        .argParser((v) => Number.parseInt(v, 10)),
    )
    .addOption(
      new Option(
        '--min-suites <suites>',
        'Report a failure only once it appears in this many SUITES.',
      )
        .default(2)
        .argParser((v) => Number.parseInt(v, 10)),
    )
    .option('--suite <suite>', 'Filter to a specific suite.')
    .addOption(
      new Option(
        '--output <dir>',
        'Directory the Markdown artifacts are ' + 'written to.',
      ).default('test-results/analysis'),
    )
    .option('--json', 'Emit per-section counts as JSON instead of the digest.')
    .option('--slack', 'Emit a short Slack-formatted summary.')
    .addOption(new Option('--db-url <url>', DB_URL_DESC).env(DB_URL_ENV))
    .action(async (opts: DigestOptions, cmd: Command) => {
      await digestCmd(
        resolveUnitFlags(opts, cmd, deps, [WINDOW_ALIAS, DELTA_ALIAS]),
        deps,
      );
    });

  for (const sub of program.commands) {
    sub.exitOverride(normalizeUsageExit);
  }

  return program;
}

/** The production `analyze` command (process-backed defaults). */
export const analyzeCommand: Command = createAnalyzeCommand();
