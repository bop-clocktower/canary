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

import * as overlay from "./overlay-commands.js";
import type { CommandDeps } from "./overlay-commands.js";

/** Subcommands handled in TypeScript rather than forwarded to the binary. */
export const TS_COMMANDS: readonly string[] = ["overlay"];

/** True when `argv` (process.argv.slice(2)) targets a TS-handled command. */
export function isTsCommand(argv: readonly string[]): boolean {
  return argv.length > 0 && TS_COMMANDS.includes(argv[0]);
}

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** Minimal flag parser: `--k v`, `--k=v`, and boolean `--k`. */
function parseArgs(args: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function refFrom(flags: Record<string, string | boolean>): string | null {
  const ref = flags.ref;
  return typeof ref === "string" ? ref : null;
}

const OVERLAY_USAGE =
  "usage: canary overlay <add|list|update|remove> [args]\n" +
  "  add <source> [--ref <tag>]   list   update [name]   remove <name>\n";

function runOverlay(args: readonly string[], deps: CommandDeps): number {
  const err = deps.err ?? process.stderr;
  const { positionals, flags } = parseArgs(args.slice(1));
  switch (args[0]) {
    case "add":
      if (positionals.length < 1) {
        err.write("usage: canary overlay add <source> [--ref <tag>]\n");
        return 1;
      }
      return overlay.add(positionals[0], { ref: refFrom(flags) }, deps);
    case "list":
      return overlay.list(deps);
    case "update":
      return overlay.update(positionals[0] ?? null, deps);
    case "remove":
      if (positionals.length < 1) {
        err.write("usage: canary overlay remove <name>\n");
        return 1;
      }
      return overlay.remove(positionals[0], deps);
    default:
      err.write(`canary overlay: unknown subcommand ${args[0] ? `'${args[0]}'` : "(none)"}\n${OVERLAY_USAGE}`);
      return 1;
  }
}

/**
 * Dispatch a TS-handled command. Returns the process exit code, or `null` when
 * the command should fall through to the Python binary. `deps` is threaded to
 * the command handlers for testing (real dependencies by default).
 */
export function route(argv: readonly string[], deps: CommandDeps = {}): number | null {
  if (!isTsCommand(argv)) {
    return null;
  }
  if (argv[0] === "overlay") {
    return runOverlay(argv.slice(1), deps);
  }
  return null;
}
