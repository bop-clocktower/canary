"use strict";

/**
 * Router for TS-handled `canary` subcommands — the strangler seam (Decision 10).
 *
 * The npm shim (`bin/canary.js`) forwards every command to the bundled Python
 * binary except the ones handled here in TypeScript. Phase 1 wires `overlay`;
 * `doctor` slots into the same table in Phase 2.
 *
 * `route()` returns a process exit code, or `null` when the command is not
 * TS-handled and the shim should fall through to the Python binary.
 */

/** Subcommands handled in TypeScript rather than forwarded to the binary. */
export const TS_COMMANDS: readonly string[] = ["overlay"];

/** True when `argv` (process.argv.slice(2)) targets a TS-handled command. */
export function isTsCommand(argv: readonly string[]): boolean {
  return argv.length > 0 && TS_COMMANDS.includes(argv[0]);
}

/**
 * Dispatch a TS-handled command. Task 2 implements real dispatch; this Phase 1
 * scaffold only proves the build pipeline (`tsc` → `dist/`) and the shim seam.
 */
export function route(argv: readonly string[]): number | null {
  if (!isTsCommand(argv)) {
    return null;
  }
  // Placeholder — overlay dispatch lands in Task 2.
  process.stderr.write("canary: overlay commands are not wired yet\n");
  return 1;
}
