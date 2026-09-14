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
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';

import { CliExitError } from './cli-common.js';
import { EXIT_ABSTAINED } from './core/gate-result.js';
import { scoreCiReady, type CiReadyReport } from './core/ci-ready.js';
import { NdjsonHistoryStore } from './history/ndjson-store.js';
import type { RunRecord } from './history/record.js';
import type { MainDeps } from './main-deps.js';

/** Same default location `canary history` writes to (DEFAULT_HISTORY_FILE in history/cli.ts). */
const HISTORY_FILE = join('test-results', 'reports', 'history-v2.jsonl');

function readRuns(root: string): RunRecord[] | null {
  const path = join(root, HISTORY_FILE);
  return existsSync(path) ? new NdjsonHistoryStore(path).readAll() : null;
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
        hasInventory: existsSync(join(root, '.canary', 'test-inventory.json')),
        hasCriticalAreas: existsSync(
          join(root, '.canary', 'critical-areas.json'),
        ),
      });
      if (opts.json === true) {
        deps.out(JSON.stringify(report, null, 2));
      } else {
        for (const line of renderText(report)) deps.out(line);
      }
      const code = exitCodeFor(report);
      if (code !== 0) throw new CliExitError(code);
    });
  return command;
}
