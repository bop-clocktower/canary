/**
 * `canary history record` -- convert a finished runner report into a run and
 * append it to the history store.
 *
 * One of the four subcommand-family modules the `history` command root was
 * split into for #1074; see `../cli.ts` for the seam and the rule. The outcome
 * rendering (`--json` payload, dry-run and success lines) lives next door in
 * `outcome-cli.ts` so this file stays about the decision to record.
 *
 * Named `cli.ts` on purpose, following `../retention/cli.ts`: layer binding is
 * by filename (`ts/src/**\/*cli*.ts` is the `cli` layer, first match wins), and
 * this module imports `cli-common`.
 *
 * `record` is NOT a Python port. Nothing in either engine ever wrote the local
 * store, which is why the whole `analyze` / `history` surface had only ever
 * been exercised against synthetic fixtures (#538). Its conversion half lives
 * in `../run-recorder.ts`; it takes the async store contract per ADR 0013, so
 * it writes local NDJSON or the remote store by configuration.
 */

import { Command, Option } from 'commander';
import pc from 'picocolors';

import { ReportReadError, readReport } from '../formats/report-file.js';

import { CliExitError, jsonIndent2 } from '../../cli-common.js';
import { gateOutcome } from '../../core/gate-result.js';
import {
  buildRunFromReport,
  countReportResults,
  detectReportShape,
  RecordValidationError,
  type BuiltRun,
  type RecordContext,
  type ReportShape,
} from '../run-recorder.js';
import { def } from '../../util/coalesce.js';
import {
  prepareRecordedRun,
  resolveCommit,
  type KeyedRun,
} from '../keys/replay-context.js';
import type { HistoryDeps } from '../cli-deps.js';
import {
  abstainOnEmptyReport,
  countsLine,
  reportDryRun,
  reportRecorded,
} from './outcome-cli.js';

const DEFAULT_HISTORY_FILE = 'test-results/reports/history-v2.jsonl';

// --- record ------------------------------------------------------------------

interface RecordOptions {
  suite: string;
  repo?: string;
  branch?: string;
  commit?: string;
  seed?: string;
  orderPlan?: string;
  path?: string;
  runId?: string;
  dbUrl?: string;
  dryRun?: boolean;
  json?: boolean;
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
    commitSha: def(opts.commit, 'local'),
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
  let parsed: unknown;
  try {
    parsed = readReport(resultsFile);
  } catch (err) {
    if (!(err instanceof ReportReadError)) throw err;
    deps.out(`${pc.red(err.label)} ${err.detail}`);
    throw new CliExitError(1);
  }
  const shape = detectReportShape(parsed);
  if (shape === 'unknown') {
    deps.out(
      `${pc.red('Unrecognized report:')} ${resultsFile} carries neither a ` +
        `\`testResults\` array (vitest --reporter=json), a top-level ` +
        `\`suites\` array (Playwright --reporter=json), nor a ` +
        `\`<testsuites>\`/\`<testsuite>\` root (JUnit XML). \`record\` reads ` +
        `vitest JSON, Playwright JSON and JUnit XML.`,
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

  const commit = resolveCommit(opts.commit, deps.env, deps, deps.err);
  const built = prepareRecordedRun(
    buildOrRefuse(
      shape,
      parsed,
      recordContext({ ...opts, commit: commit.sha }, deps),
      deps,
    ),
    { shape, parsed },
    deps,
    { seed: opts.seed, commitSource: commit.source, orderPlan: opts.orderPlan },
  );

  const remote = opts.dbUrl ?? deps.env['CANARY_HISTORY_DB_URL'];
  const storePath = opts.path ?? DEFAULT_HISTORY_FILE;
  const target = remote ? 'the configured remote store' : storePath;

  if (opts.dryRun) {
    reportDryRun(built, target, opts, deps, shape);
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

  reportRecorded(built, target, opts, deps, shape);
}

/** Convert the report, or exit 1 before any append if it would poison reads. */
function buildOrRefuse(
  shape: ReportShape,
  parsed: unknown,
  ctx: RecordContext,
  deps: HistoryDeps,
): BuiltRun {
  try {
    return buildRunFromReport(shape, parsed, ctx);
  } catch (err) {
    if (!(err instanceof RecordValidationError)) throw err;
    deps.out(
      `${pc.red('Invalid results:')} ${err.message}. Nothing was recorded ` +
        `\u{2014} a malformed record degrades every later read of the store.`,
    );
    throw new CliExitError(1);
  }
}

// --- registration ------------------------------------------------------------

/** Mount `history record` onto the `history` command. */
export function registerRecordCommand(
  program: Command,
  deps: HistoryDeps,
): void {
  program
    .command('record')
    .description(
      'Record a finished test run into the history store (vitest JSON, Playwright JSON or JUnit XML).',
    )
    .argument(
      '<results_file>',
      "Path to the runner's report (vitest/Playwright JSON or JUnit XML).",
    )
    .requiredOption('--suite <suite>', 'Suite name for this run (e.g. e2e).')
    .option('--repo <repo>', 'GitHub repo slug (default: $GITHUB_REPOSITORY).')
    .option('--branch <branch>', 'Branch name (default: $GITHUB_REF_NAME).')
    .option('--commit <sha>', 'Commit SHA (default: $GITHUB_SHA).')
    .option('--seed <seed>', 'Runner seed, recorded for replay.')
    .option('--order-plan <file>', 'canary order plan; records TTFF estimates.')
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
}
