#!/usr/bin/env node
// canary-dev-pipeline -- advisory dev-time test guidance for the working diff
// (#666).
//
// One command for the middle of a change: with no arguments it reads the
// working diff, runs the cheap deterministic members over it (critical-areas
// risk, katana test ties, savant and blackhawk on changed tests) inside a time
// budget, and prints a brief naming what to look at next. It composes existing
// skills; it is no new analysis engine, no test runner and no gate.
//
// Exit codes (spec Q4):
//   0  a brief was rendered, whatever it found -- findings never fail a run
//   1  the --out file could not be written (not a finding)
//   2  usage error
//   3  abstained (ADR 0009): nothing to analyse, or no member checked anything
//
// Invoked via `canary skills run canary-dev-pipeline -- [path ...]`.

import {
  createParser,
  formatUsageError,
  EXIT_USAGE,
} from '../../../lib/parse-args.mjs';
import { isMain } from '../../../lib/is-main.mjs';
import { DEFAULT_BUDGET_MS } from './budget.mjs';
import { execute } from './run.mjs';

// The work lives in run.mjs -> brief.mjs -> members.mjs, so no module imports
// more than four others (the perf ratchet's coupling rule).

const USAGE =
  'usage: canary-dev-pipeline [-h] [--repo DIR] [--json] [--out PATH]\n' +
  '                           [--budget-ms N] [--] [path ...]\n' +
  '\n' +
  'Advisory dev-time brief for the work in front of you: risk, test ties,\n' +
  'isolation and temporal smells over the working diff (or the named paths).\n' +
  'Findings never change the exit code; nothing to analyse exits 3.\n' +
  '\n' +
  'positional arguments:\n' +
  '  path            files or directories to analyse instead of the working diff\n' +
  '\n' +
  'options:\n' +
  '  -h, --help      show this help message and exit\n' +
  '  --repo DIR      repository to read (default: the current directory)\n' +
  '  --json          emit the brief as JSON instead of Markdown\n' +
  '  --out PATH      also write the brief to PATH\n' +
  `  --budget-ms N   time budget in milliseconds (default: ${DEFAULT_BUDGET_MS})`;

export const CLI_SPEC = {
  prog: 'canary-dev-pipeline',
  booleans: { '--json': 'json' },
  values: {
    '--repo': { key: 'repo' },
    '--out': { key: 'out' },
    '--budget-ms': { key: 'budgetMs', type: 'int' },
  },
  defaults: { repo: '.', budgetMs: DEFAULT_BUDGET_MS },
  positionals: { key: 'paths' },
};

const parseArgs = createParser(CLI_SPEC);

function usageError(argv) {
  const { opts, positionals, help, error } = parseArgs(argv);
  if (help || error) return { help, error, opts };
  if (opts.budgetMs < 0) {
    return { error: 'argument --budget-ms: must be 0 or more', opts };
  }
  return { opts: { ...opts, paths: positionals } };
}

/**
 * @param {string[]} argv
 * @param {{clock?: () => number, cwd?: string}} [deps]
 * @returns {number}
 */
export function main(argv = [], deps = {}) {
  const { help, error, opts } = usageError(argv);
  if (help) {
    console.log(USAGE);
    return 0;
  }
  if (error) {
    console.error(formatUsageError(CLI_SPEC.prog, error));
    return EXIT_USAGE;
  }
  return execute(opts, deps);
}

// `process.exitCode`, not `process.exit()`: a large brief can exceed the pipe
// buffer, and `process.exit` would truncate it mid-write (#791).
if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
