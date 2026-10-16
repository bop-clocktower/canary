#!/usr/bin/env node
/**
 * `canary` npm entry point. Runs the built main command via
 * `parseAsync(argv, { from: 'user' })` and maps the CLI's business/usage exits
 * to a process exit code:
 *   - `CliExitError(code)`  -> exit(code)   (Python `typer.Exit`)
 *   - `CommanderError` -> exit(exitCode) (usage errors: 2; --help/-V: 0)
 *   - anything else    -> print + exit 1 (unexpected crash)
 * Every forced exit waits for stdout/stderr to drain first (`exitAfterDrain`).
 *
 * This is the sole `canary` entry point; the Python console script was retired
 * in the v6 cutover.
 */

import { createRequire } from 'node:module';

import { CommanderError } from 'commander';

import { createCanaryCommand } from '../dist/cli.js';
import { CliExitError } from '../dist/cli-common.js';

const require = createRequire(import.meta.url);

function readVersion() {
  try {
    return require('../package.json').version || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Exit with `code` once stdout and stderr have drained (#1284). On an async
 * pipe (macOS, Windows) a bare `process.exit` discards queued writes, cutting a
 * large `--json` off at the pipe buffer. An empty write's callback fires only
 * after everything queued before it, so it marks the drain point. The exit
 * stays forced, unlike `process.exitCode`, so an open handle cannot hang a
 * command that has already finished.
 */
function exitAfterDrain(code) {
  process.stdout.write('', () => {
    process.stderr.write('', () => process.exit(code));
  });
}

const program = createCanaryCommand({ pkgVersion: () => readVersion() });

try {
  await program.parseAsync(process.argv.slice(2), { from: 'user' });
} catch (err) {
  if (err instanceof CliExitError) {
    exitAfterDrain(err.code);
  } else if (err instanceof CommanderError) {
    exitAfterDrain(err.exitCode);
  } else {
    console.error(err);
    exitAfterDrain(1);
  }
}
