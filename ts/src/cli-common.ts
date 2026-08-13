/**
 * Shared plumbing for the Canary commander CLIs (main program + `history` and
 * `analyze` sub-apps), factored out of the guardian CLI pattern established in
 * `guardian/cli.ts`.
 *
 * The three concerns every command tree needs:
 *
 *   - {@link CliExitError} -- the business-exit signal thrown from a handler
 *     (Python `typer.Exit(code)`). Re-exported from `guardian/cli.ts` so the
 *     ENTIRE command tree (main program, its sub-apps, AND the already-ported
 *     guardian sub-app it mounts) throws ONE class. `bin/canary.js` catches one
 *     `CliExitError` regardless of which sub-app raised it.
 *   - {@link normalizeUsageExit} -- the `.exitOverride()` callback that maps
 *     commander's usage-error exit code (1) to typer/click's 2, while leaving an
 *     explicit `--help`/`--version` at 0. Applied to the program AND every
 *     subcommand.
 *   - {@link jsonIndent2} -- Python `json.dumps(x, indent=2)` fidelity: the
 *     separators match `JSON.stringify(x, null, 2)` byte-for-byte, and the
 *     `ensure_ascii=True` default is restored by `ensureAscii`.
 *
 * `ensureAscii` itself used to be declared and exported here, and was imported
 * by nobody while eight modules carried private copies (#710). It now lives in
 * `util/ensure-ascii.ts` -- the one layer `core`, `guardian`, and the entry
 * modules are all permitted to depend on, which `cli` is not.
 */

import { CommanderError } from 'commander';

import { ensureAscii } from './util/ensure-ascii.js';

export { CliExitError } from './guardian/cli.js';

/**
 * Map commander's usage-error exit code to typer/click's `2`. Commander defaults
 * unknown/missing-option, bad-command and no-args-help errors to exit 1; typer
 * uses 2. Explicit `--help`/`--version` exit 0 in BOTH, so leave those. Used as
 * the `.exitOverride()` callback on the program and every subcommand.
 */
export function normalizeUsageExit(err: CommanderError): never {
  if (
    err.code !== 'commander.helpDisplayed' &&
    err.code !== 'commander.version'
  ) {
    err.exitCode = 2;
  }
  throw err;
}

/**
 * `json.dumps(x, indent=2)` fidelity: `JSON.stringify(x, null, 2)` reproduces
 * Python's 2-space indent and `(',', ': ')` separators byte-for-byte (including
 * `[]`/`{}` for empty containers), and {@link ensureAscii} restores the
 * `ensure_ascii=True` default. A trailing newline is NOT added here -- callers
 * that mirror `sys.stdout.write(... + "\n")` add it via their line sink.
 */
export function jsonIndent2(value: unknown): string {
  return ensureAscii(JSON.stringify(value, null, 2));
}
