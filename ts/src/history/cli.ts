/**
 * The `canary history` command root.
 *
 * This module owns the command's identity and nothing else: it builds the
 * `history` program, hands it to each half's registrar, and normalizes usage
 * exits. The subcommand bodies live one directory down --
 * `record/cli.ts` (`record`), `publish/cli.ts` (`push`, `migrate`),
 * `reporting/cli.ts` (`flaky`, `timeline`, `summary`), and `retention/cli.ts`
 * (`trim`, mounted from the #988 domain registry in
 * `../commands/engine/cli.ts`).
 *
 * Why it is shaped this way (#1074): `ts/src/history` sat EXACTLY on its
 * 1800-LOC arch module ceiling and this file EXACTLY on the 15-import perf
 * threshold, so the next `history` subcommand tripped both required checks on
 * its first CI run, and the perf delta rule is unwaivable (`--admin` cannot
 * bypass a red required check). The seam chosen is the direction data flows --
 * the write side captures and publishes runs, the read side queries them --
 * because that is the axis a new subcommand lands on. The rule this
 * establishes: **a new `history` subcommand joins the family it belongs to, or
 * opens its own directory; it does not grow this file.** The root gains at
 * most one import per new seam, and the module-size ceiling is charged to the
 * new directory rather than to `ts/src/history`.
 *
 * Follows the guardian CLI conventions (see `../cli-common.ts`): a
 * {@link createHistoryCommand} factory wired to an injectable {@link HistoryDeps}
 * (out/err sinks, env, a store factory), `CliExitError` for business exits, and
 * `normalizeUsageExit` on every command so usage errors exit 2.
 */

import { Command } from 'commander';

import { normalizeUsageExit } from '../cli-common.js';
import { defaultHistoryDeps, type HistoryDeps } from './cli-deps.js';
import { registerRecordCommand } from './record/cli.js';
import { registerPublishCommands } from './publish/cli.js';
import { registerReportingCommands } from './reporting/cli.js';

export type { HistoryDeps };

/** Build a fresh `history` command wired to `depsInit`. */
export function createHistoryCommand(
  depsInit: Partial<HistoryDeps> = {},
): Command {
  const deps: HistoryDeps = { ...defaultHistoryDeps(), ...depsInit };

  const program = new Command('history');
  program
    .description('Query and manage test run history.')
    .exitOverride(normalizeUsageExit);

  // Order is help order, and help order is the order a reader meets the
  // lifecycle: capture a run, publish it, then ask questions of the store.
  registerRecordCommand(program, deps);
  registerPublishCommands(program, deps);
  registerReportingCommands(program, deps);

  for (const sub of program.commands) {
    sub.exitOverride(normalizeUsageExit);
  }

  return program;
}

/** The production `history` command (process-backed defaults). */
export const historyCommand: Command = createHistoryCommand();
