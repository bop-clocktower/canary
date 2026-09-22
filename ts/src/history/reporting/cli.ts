/**
 * The read half of `canary history`: the subcommands that ANSWER questions from
 * the store without writing to it (`flaky`, `timeline`, `summary`).
 *
 * One of the four subcommand-family modules the `history` command root was
 * split into for #1074; see `../cli.ts` for the seam and the rule. The three
 * share this module because they share the read-side denominator guard
 * ({@link abstainOnEmptyHistory}) and the run-count flag parser -- an empty
 * store has to read as unknown rather than clean in all three (#508).
 *
 * Named `cli.ts` on purpose, following `../retention/cli.ts`: layer binding is
 * by filename (`ts/src/**\/*cli*.ts` is the `cli` layer, first match wins),
 * and this module imports `cli-common`.
 *
 * INTENTIONAL Python->TS DEVIATION: `flaky` and `timeline` render with
 * `rich.Table` (box-drawing). Reproducing rich's exact box bytes is brittle and
 * no Python CLI test pins them, so this port emits a simple aligned text table
 * carrying the SAME cell content. `summary` is not a table and IS reproduced
 * byte-for-byte via picocolors stripping on a non-TTY sink.
 */

import { Command, InvalidArgumentError, Option } from 'commander';
import pc from 'picocolors';

import { jsonIndent2 } from '../../cli-common.js';
import { gateOutcome } from '../../core/gate-result.js';
import type { AsyncHistoryStore } from '../store.js';
import { describeFlakyWindow } from '../flake/window.js';
import {
  buildFlakyEnvelope,
  emptyStoreEnvelope,
} from '../../util/flake-window.js';
import { renderFlakyReport, renderTable } from '../flake/render.js';
import { formatWithDecimalPoint } from '../../util/round.js';
import type { HistoryDeps } from '../cli-deps.js';

const EM_DASH = '\u{2014}';
const MDASH_CELL = '\u{2014}'; // rich `r.get("area") or <em-dash>`

/**
 * A whole count of runs, >= 1 (same rule `canary analyze` adopted in #673).
 *
 * The bare `Number.parseInt` this replaces let `--window 0` and `--window
 * seven` through; the store then sliced with `-0` / `NaN`, which reads EVERY
 * run -- the widest window, reported under the narrowest flag.
 */
function parseRunCount(flag: string): (raw: string) => number {
  return (raw) => {
    if (!/^\d+$/.test(raw.trim()) || Number.parseInt(raw, 10) < 1) {
      throw new InvalidArgumentError(
        `${flag} takes a whole number of RUNS, at least 1; got "${raw}".`,
      );
    }
    return Number.parseInt(raw, 10);
  };
}

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
  emptyPayload: unknown = [],
): Promise<boolean> {
  if (store.countRuns === undefined) return false; // unknown, not zero
  if ((await store.countRuns()) > 0) return false;
  const outcome = gateOutcome({ checked: 0, findings: [] }, 'advisory');
  const notice =
    `${outcome.summaryLine} No runs recorded, so ${what} is unknown rather ` +
    `than clean. Record runs first (\`canary history push\`), then re-run.`;
  if (json) {
    deps.out(jsonIndent2(emptyPayload));
    deps.err(notice);
  } else {
    deps.out(notice);
  }
  return true;
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
  const suite = opts.suite ?? null;
  const json = opts.json === true;
  const empty = emptyStoreEnvelope(opts.window);
  if (await abstainOnEmptyHistory(store, deps, json, 'flake rate', empty)) {
    return;
  }
  const results = await store.queryFlaky(opts.window, suite, opts.minRate);
  const win = await describeFlakyWindow(store, opts.window, suite);

  if (json) {
    deps.out(jsonIndent2(buildFlakyEnvelope(results, opts.window, win)));
    return;
  }
  for (const line of renderFlakyReport(
    results,
    opts.window,
    opts.minRate,
    win,
  )) {
    deps.out(line);
  }
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
    `Suite ${pc.bold(suite)} ${EM_DASH} last ${total} runs ${EM_DASH} avg pass rate: ${colorize(`${formatWithDecimalPoint(avg)}%`)}`,
  );
}

// --- registration ------------------------------------------------------------

/**
 * Mount the reporting subcommands onto the `history` command.
 *
 * A registrar rather than a second `Command` tree: `canary history flaky` has
 * to stay one flat namespace, and `../retention/cli.ts` established the same
 * `register*Command` shape for `history trim` (#1024).
 */
export function registerReportingCommands(
  program: Command,
  deps: HistoryDeps,
): void {
  program
    .command('flaky')
    .description('Show tests ranked by flake rate over the rolling window.')
    .addOption(
      new Option('-w, --window <n>', 'Rolling window (number of runs).')
        .default(30)
        .argParser(parseRunCount('--window')),
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
        .argParser(parseRunCount('--runs')),
    )
    .addOption(new Option('--db-url <url>').env('CANARY_HISTORY_DB_URL'))
    .option('--json')
    .action(async (suite: string, opts: SummaryOptions) => {
      await summaryCmd(suite, opts, deps);
    });
}
