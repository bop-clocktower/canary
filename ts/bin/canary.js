#!/usr/bin/env node
/**
 * `canary` npm entry point. Runs the built main command via
 * `parseAsync(argv, { from: 'user' })` and maps the CLI's business/usage exits
 * to a process exit code:
 *   - `CliExit(code)`  -> process.exit(code)   (Python `typer.Exit`)
 *   - `CommanderError` -> process.exit(exitCode) (usage errors: 2; --help/-V: 0)
 *   - anything else    -> print + exit 1        (unexpected crash)
 *
 * This is the sole `canary` entry point; the Python console script was retired
 * in the v6 cutover.
 */

import { createRequire } from 'node:module';

import { CommanderError } from 'commander';

import { createCanaryCommand } from '../dist/cli.js';
import { CliExit } from '../dist/cli-common.js';

const require = createRequire(import.meta.url);

function readVersion() {
  try {
    return require('../package.json').version || 'unknown';
  } catch {
    return 'unknown';
  }
}

const program = createCanaryCommand({ pkgVersion: () => readVersion() });

try {
  await program.parseAsync(process.argv.slice(2), { from: 'user' });
} catch (err) {
  if (err instanceof CliExit) process.exit(err.code);
  if (err instanceof CommanderError) process.exit(err.exitCode);
  console.error(err);
  process.exit(1);
}
