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
 *   - INTENTIONAL DEVIATION: the TS analysis engine (`engine.ts`) operates on the
 *     LOCAL NDJSON store only -- the JS Supabase SDK is async and the engine's
 *     query surface is synchronous. `--db-url` is still accepted (faithful CLI
 *     surface) but the TS port always reads the local store, exactly as the
 *     Python `isinstance(store, LocalHistoryStore)` read-path does for the
 *     spikes/common-failures commands. No Python analyze test exercises a remote
 *     store.
 *   - `area-health` accepts `--json` but ignores it -- faithful to the Python
 *     command, which never branches on `output_json`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Command, Option } from 'commander';

import { jsonIndent2, normalizeUsageExit } from '../cli-common.js';
import { AnalysisEngine } from './engine.js';
import {
  buildAreaHealthReport,
  buildCommonFailuresReport,
  buildFlakyReport,
  buildRegressionCandidatesReport,
  buildSpikesReport,
} from './reports.js';
import { NdjsonHistoryStore } from '../history/ndjson-store.js';

const DEFAULT_HISTORY_PATH = 'test-results/reports/history-v2.jsonl';

/** Injected outside-world seams (out sink, env, local-store factory). */
export interface AnalyzeDeps {
  out(s: string): void;
  err(s: string): void;
  env: NodeJS.ProcessEnv;
  makeStore(dbUrl?: string): NdjsonHistoryStore;
}

/** Process-backed defaults for production. */
export function defaultAnalyzeDeps(): AnalyzeDeps {
  const err = (s: string): void => {
    process.stderr.write(`${s}\n`);
  };
  return {
    out: (s) => process.stdout.write(`${s}\n`),
    err,
    env: process.env,
    // The ported analysis engine's query surface is synchronous, so it cannot
    // drive the async Supabase store; analyze reads local NDJSON only. Python
    // honors --db-url / CANARY_HISTORY_DB_URL via make_store, so warn (to stderr,
    // not stdout -- keeps --json clean) rather than SILENTLY reading a different
    // data source. Full remote support is deferred with the async engine port.
    makeStore: (dbUrl?: string) => {
      if (dbUrl) {
        err(
          'note: --db-url is ignored by analyze; it reads local NDJSON only.',
        );
      }
      return new NdjsonHistoryStore(DEFAULT_HISTORY_PATH);
    },
  };
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
  window: number;
  suite?: string;
  minRate: number;
  dbUrl?: string;
  json?: boolean;
}

function flakyCmd(opts: FlakyOptions, deps: AnalyzeDeps): void {
  const store = deps.makeStore(opts.dbUrl);
  const rows = store.queryFlaky(opts.window, opts.suite ?? null, opts.minRate);
  if (opts.json) {
    deps.out(jsonIndent2(rows));
  } else {
    deps.out(buildFlakyReport(rows, opts.window, opts.minRate));
  }
}

// --- spikes ------------------------------------------------------------------

interface SpikesOptions {
  since?: string;
  delta: number;
  dbUrl?: string;
  json?: boolean;
}

function spikesCmd(opts: SpikesOptions, deps: AnalyzeDeps): void {
  const store = deps.makeStore(opts.dbUrl);
  const rows: {
    suite: string;
    timestamp: string;
    passed: number;
    failed: number;
    flaky: number;
    total: number;
  }[] = [];
  for (const r of store.readAll()) {
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
    deps.out(buildSpikesReport(rows, opts.delta));
  }
}

// --- area-health -------------------------------------------------------------

interface AreaHealthOptions {
  weeks: number;
  dbUrl?: string;
  json?: boolean;
}

function areaHealthCmd(opts: AreaHealthOptions, deps: AnalyzeDeps): void {
  // Faithful to Python: always builds from an empty row set and never branches
  // on --json.
  deps.out(buildAreaHealthReport([], opts.weeks));
}

// --- common-failures ---------------------------------------------------------

interface CommonFailuresOptions {
  since?: string;
  minSuites: number;
  dbUrl?: string;
  json?: boolean;
}

function commonFailuresCmd(
  opts: CommonFailuresOptions,
  deps: AnalyzeDeps,
): void {
  const store = deps.makeStore(opts.dbUrl);
  const rows: {
    test_name: string;
    suite: string;
    failure_category: string;
    error_text: string;
    run_count: number;
  }[] = [];
  for (const record of store.readAll()) {
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

function regressionCandidatesCmd(
  opts: RegressionOptions,
  deps: AnalyzeDeps,
): void {
  const engine = new AnalysisEngine(deps.makeStore(opts.dbUrl));
  const candidates = engine.detectRegressionCandidates(
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
  window: number;
  delta: number;
  weeks: number;
  minSuites: number;
  suite?: string;
  output: string;
  json?: boolean;
  slack?: boolean;
  dbUrl?: string;
}

function digestCmd(opts: DigestOptions, deps: AnalyzeDeps): void {
  const engine = new AnalysisEngine(deps.makeStore(opts.dbUrl));
  const result = engine.run({
    window: opts.window,
    delta: opts.delta,
    weeks: opts.weeks,
    minSuites: opts.minSuites,
    suite: opts.suite ?? null,
  });
  writeArtifacts(result.artifacts, opts.output);

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
      new Option('-w, --window <n>')
        .default(30)
        .argParser((v) => Number.parseInt(v, 10)),
    )
    .option('-s, --suite <suite>')
    .addOption(
      new Option('--min-rate <pct>')
        .default(10.0)
        .argParser((v) => Number.parseFloat(v)),
    )
    .addOption(new Option('--db-url <url>').env('CANARY_HISTORY_DB_URL'))
    .option('--json')
    .action((opts: FlakyOptions) => {
      flakyCmd(opts, deps);
    });

  program
    .command('spikes')
    .description('Recent failure spikes across suites.')
    .option('--since <date>', 'ISO date filter, e.g. 2026-06-01')
    .addOption(
      new Option('--delta <pp>')
        .default(20.0)
        .argParser((v) => Number.parseFloat(v)),
    )
    .addOption(new Option('--db-url <url>').env('CANARY_HISTORY_DB_URL'))
    .option('--json')
    .action((opts: SpikesOptions) => {
      spikesCmd(opts, deps);
    });

  program
    .command('area-health')
    .description('Area degradation trends over time.')
    .addOption(
      new Option('--weeks <n>')
        .default(4)
        .argParser((v) => Number.parseInt(v, 10)),
    )
    .addOption(new Option('--db-url <url>').env('CANARY_HISTORY_DB_URL'))
    .option('--json')
    .action((opts: AreaHealthOptions) => {
      areaHealthCmd(opts, deps);
    });

  program
    .command('common-failures')
    .description('Cross-suite failure fingerprinting.')
    .option('--since <date>')
    .addOption(
      new Option('--min-suites <n>')
        .default(2)
        .argParser((v) => Number.parseInt(v, 10)),
    )
    .addOption(new Option('--db-url <url>').env('CANARY_HISTORY_DB_URL'))
    .option('--json')
    .action((opts: CommonFailuresOptions) => {
      commonFailuresCmd(opts, deps);
    });

  program
    .command('regression-candidates')
    .description('Tests newly and consistently broken after a green streak.')
    .addOption(
      new Option('--min-green <n>')
        .default(5)
        .argParser((v) => Number.parseInt(v, 10)),
    )
    .addOption(
      new Option('--recent-failures <n>')
        .default(3)
        .argParser((v) => Number.parseInt(v, 10)),
    )
    .addOption(new Option('--db-url <url>').env('CANARY_HISTORY_DB_URL'))
    .option('--json')
    .action((opts: RegressionOptions) => {
      regressionCandidatesCmd(opts, deps);
    });

  program
    .command('digest')
    .description('Combined digest of all five report types.')
    .addOption(
      new Option('--window <n>')
        .default(30)
        .argParser((v) => Number.parseInt(v, 10)),
    )
    .addOption(
      new Option('--delta <pp>')
        .default(20.0)
        .argParser((v) => Number.parseFloat(v)),
    )
    .addOption(
      new Option('--weeks <n>')
        .default(4)
        .argParser((v) => Number.parseInt(v, 10)),
    )
    .addOption(
      new Option('--min-suites <n>')
        .default(2)
        .argParser((v) => Number.parseInt(v, 10)),
    )
    .option('--suite <suite>')
    .addOption(new Option('--output <dir>').default('test-results/analysis'))
    .option('--json')
    .option('--slack')
    .addOption(new Option('--db-url <url>').env('CANARY_HISTORY_DB_URL'))
    .action((opts: DigestOptions) => {
      digestCmd(opts, deps);
    });

  for (const sub of program.commands) {
    sub.exitOverride(normalizeUsageExit);
  }

  return program;
}

/** The production `analyze` command (process-backed defaults). */
export const analyzeCommand: Command = createAnalyzeCommand();
