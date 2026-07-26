/**
 * Shared plumbing for the Canary commander CLIs (main program + `history` and
 * `analyze` sub-apps), factored out of the guardian CLI pattern established in
 * `guardian/cli.ts`.
 *
 * The three concerns every command tree needs:
 *
 *   - {@link CliExit} -- the business-exit signal thrown from a handler (Python
 *     `typer.Exit(code)`). Re-exported from `guardian/cli.ts` so the ENTIRE
 *     command tree (main program, its sub-apps, AND the already-ported guardian
 *     sub-app it mounts) throws ONE class. `bin/canary.js` then catches a single
 *     `CliExit` regardless of which sub-app raised it.
 *   - {@link normalizeUsageExit} -- the `.exitOverride()` callback that maps
 *     commander's usage-error exit code (1) to typer/click's 2, while leaving an
 *     explicit `--help`/`--version` at 0. Applied to the program AND every
 *     subcommand.
 *   - {@link ensureAscii} / {@link jsonIndent2} -- Python `json.dumps` fidelity:
 *     `ensure_ascii=True` (per-UTF-16-unit escaping, so astral chars emit a
 *     surrogate pair exactly like CPython) and the `indent=2` pretty form (whose
 *     separators match `JSON.stringify(x, null, 2)` byte-for-byte).
 */

import { CommanderError } from 'commander';

export { CliExit } from './guardian/cli.js';

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
 * Escape every non-ASCII UTF-16 code UNIT to `\uXXXX`, matching Python
 * `json.dumps(ensure_ascii=True)`. Iterating by unit (not code point) means an
 * astral char's surrogate pair emits `\udXXX\udXXX`, exactly like CPython; a
 * code-point regex would stop at U+FFFF and leave astral chars raw.
 */
export function ensureAscii(json: string): string {
  let out = '';
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    out += c >= 0x80 ? '\\u' + c.toString(16).padStart(4, '0') : json[i];
  }
  return out;
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
