#!/usr/bin/env node
// canary-ivy -- suite overgrowth, reported, never pruned (#615, ADR 0039).
//
// Reports three suite-level facts: setup bodies repeated across files, tests
// whose covered lines coincide, and test/file durations that grew over the
// run-history store. It names what overlaps and what grew. It never says
// which test should go: that decision, and its evidence, stay with a human.
//
// Never a gate (ADR 0039, Decision 2): 0 whenever any section was assessed,
// whatever it found; 3 when no section had input (abstained, ADR 0009); 1 only
// for I/O (a named input that cannot be read, --out that cannot be written);
// 2 for usage. There is no --strict.
//
// Invoked via `canary skills run canary-ivy -- [paths] [--coverage PATH] ...`.

import {
  createParser,
  formatUsageError,
  EXIT_USAGE,
} from '../../../lib/parse-args.mjs';
import { isMain } from '../../../lib/is-main.mjs';
import { DEFAULT_HISTORY, gather } from './inputs.mjs';
import { produce, writeArtifact } from './output.mjs';
import { plain } from './text.mjs';

const PREFIX = 'canary-ivy:';

/** Exit code reserved family-wide for "abstained" (ADR 0009). */
const EXIT_ABSTAINED = 3;

const USAGE =
  'usage: canary-ivy [-h] [--coverage PATH] [--history PATH] [--json]\n' +
  '                  [--out PATH] [--] [path ...]\n' +
  '\n' +
  'Suite overgrowth report: repeated setup bodies, tests whose covered lines\n' +
  'coincide, and durations that grew over the run history. Report only: it\n' +
  'never says which test should go.\n' +
  '\n' +
  'positional arguments:\n' +
  '  path             test files or directories to read for setup blocks\n' +
  '                   (default: the current directory)\n' +
  '\n' +
  'options:\n' +
  '  -h, --help       show this help message and exit\n' +
  '  --coverage PATH  per-test coverage: coverage.py JSON with contexts, or\n' +
  '                   {"schema_version": 1, "tests": {...}}\n' +
  `  --history PATH   run-history store (default: ${DEFAULT_HISTORY})\n` +
  '  --json           print the JSON report instead of Markdown\n' +
  '  --out PATH       also write the printed report to PATH\n' +
  '\n' +
  'exit: 0 report printed, 3 nothing to read (abstained), 1 I/O error,\n' +
  '2 usage. Findings never change the exit code.';

// `--history` has no parser default ON PURPOSE: null is how main tells a dark
// default store from a typo'd path (same device as canary-question).
export const CLI_SPEC = {
  prog: 'canary-ivy',
  booleans: { '--json': 'json' },
  values: {
    '--coverage': { key: 'coverage' },
    '--history': { key: 'history' },
    '--out': { key: 'out' },
  },
  positionals: { key: 'paths', defaults: ['.'] },
};

const parseArgs = createParser(CLI_SPEC);

function fail(message) {
  console.error(`${PREFIX} ${plain(message, 400)}`);
  return 1;
}

export function main(argv = []) {
  const { opts: args, positionals: paths, help, error } = parseArgs(argv);
  if (help) {
    console.log(USAGE);
    return 0;
  }
  if (error) {
    console.error(formatUsageError(CLI_SPEC.prog, plain(error, 400)));
    return EXIT_USAGE;
  }
  const { raw, error: readError } = gather(args, paths);
  if (readError) return fail(readError);
  const { abstained, text } = produce(raw, args.json);
  console.log(text);
  const failure = args.out ? writeArtifact(args.out, text) : null;
  if (failure) return fail(failure);
  return abstained ? EXIT_ABSTAINED : 0;
}

// `process.exitCode`, not `process.exit()`: a large payload exceeds the pipe
// buffer and `process.exit` truncates it while still exiting 0 (#791).
if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
