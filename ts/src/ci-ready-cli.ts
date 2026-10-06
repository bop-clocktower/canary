/**
 * `canary ci-ready`: the deterministic scorer behind the canary-ci-ready skill.
 *
 * Reads its inputs under `--root` and hands them to the pure scoring in
 * `core/ci-ready.ts`. Exit codes follow the CLI-wide gate contract:
 *   - 3 (EXIT_ABSTAINED): every check skipped, so nothing was scored.
 *   - 1: at least one check failed.
 *   - 0: nothing failed. That covers both `ready` and `incomplete`; the text
 *     output says loudly which one it is.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';

import { CliExitError } from './cli-common.js';
import { EXIT_ABSTAINED, errnoCode } from './core/gate-result.js';
import {
  scoreCiReady,
  type CiReadyReport,
  type RunsInput,
} from './core/ci-ready.js';
import { parseCriticalAreas, parseInventory } from './core/inventory-checks.js';
import {
  HistoryContentError,
  NdjsonHistoryStore,
} from './history/ndjson-store.js';
import type { MainDeps } from './main-deps.js';

/** Same default location `canary history` writes to (DEFAULT_HISTORY_FILE in history/cli.ts). */
const HISTORY_FILE = join('test-results', 'reports', 'history-v2.jsonl');

/**
 * The run-history store as ci-ready's runs input. Absent is null; a store that
 * exists but cannot be read (EISDIR, EACCES, ...) is the reason, naming the
 * path and errno code (#1132) -- the same shape `loadInput` gives a `.canary`
 * input (#1129). A corrupt or unsupported-schema store is the same skip, naming
 * the line (#1156). Any other error is a bug, not a property of the store, and
 * still throws.
 */
function readRuns(root: string): RunsInput {
  const path = join(root, HISTORY_FILE);
  if (!existsSync(path)) return null;
  try {
    return new NdjsonHistoryStore(path).readAll();
  } catch (err) {
    if (err instanceof HistoryContentError) {
      return { ok: false, reason: err.reasonFor(HISTORY_FILE) };
    }
    const code = errnoCode(err);
    if (code === null) throw err;
    return { ok: false, reason: `${HISTORY_FILE} could not be read (${code})` };
  }
}

type Unusable = { ok: false; reason: string };

/**
 * Load one `.canary/` input through its parser. Absent (ENOENT) is the
 * parser's own "missing" case; any other read error (EISDIR, EACCES, ...) is an
 * unusable input naming the path and errno code (#1129) -- never a crash. The
 * wording follows the dossier's `parseJsonSource` (#611).
 */
function loadInput<T>(
  root: string,
  name: string,
  parse: (text: string | null) => T,
): T | Unusable {
  let text: string;
  try {
    text = readFileSync(join(root, '.canary', name), 'utf-8');
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT') return parse(null);
    const why = code ?? (err as Error).message;
    return { ok: false, reason: `.canary/${name} could not be read (${why})` };
  }
  return parse(text);
}

function renderText(report: CiReadyReport): string[] {
  const lines = [
    `CI readiness: ${report.verdict} — ${report.checked} of ${report.checks.length} checks scored`,
  ];
  for (const c of report.checks)
    lines.push(`  ${c.verdict.padEnd(4)}  ${c.name}: ${c.reason}`);
  const skipped = report.checks.length - report.checked;
  if (report.verdict === 'incomplete') {
    lines.push(
      `Incomplete: ${skipped} check(s) skipped for missing inputs, so this is not a full readiness result.`,
    );
  }
  if (report.verdict === 'abstained') {
    lines.push('Abstained: no check had an input to score.');
  }
  return lines;
}

function exitCodeFor(report: CiReadyReport): number {
  if (report.verdict === 'abstained') return EXIT_ABSTAINED;
  return report.verdict === 'not-ready' ? 1 : 0;
}

export function buildCiReadyCommand(deps: MainDeps): Command {
  const command = new Command('ci-ready');
  command
    .description(
      'Score CI readiness across five checks; checks with no input report skip, never pass.',
    )
    .option(
      '--root <dir>',
      'Repository root to read inputs from (default: current directory).',
    )
    .option('--json', 'Output the verdict and every check as JSON.')
    .action((opts: { root?: string; json?: boolean }) => {
      const root = opts.root ?? deps.cwd();
      const report = scoreCiReady({
        runs: readRuns(root),
        historyPath: HISTORY_FILE,
        inventory: loadInput(root, 'test-inventory.json', parseInventory),
        criticalAreas: loadInput(
          root,
          'critical-areas.json',
          parseCriticalAreas,
        ),
      });
      if (opts.json === true) {
        // When the checks ran, so a feed can order reports (#1151 phase 2).
        const stamped = { observed_at: new Date().toISOString(), ...report };
        deps.out(JSON.stringify(stamped, null, 2));
      } else {
        for (const line of renderText(report)) deps.out(line);
      }
      const code = exitCodeFor(report);
      if (code !== 0) throw new CliExitError(code);
    });
  return command;
}
