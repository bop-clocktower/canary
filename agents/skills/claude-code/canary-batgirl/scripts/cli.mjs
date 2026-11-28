#!/usr/bin/env node
// canary-batgirl -- team quality scorecard from evidence that is expensive to
// fake (#619).
//
// Six dimensions, each read from an artifact another canary tool writes:
// escaped defects, coverage-verified share, closure exercise share,
// unexplained switch-offs, vacuous tests and red mainline commits. Every one
// was admitted because its cheapest gaming path is NOT adding green or
// assertion-free tests (spec "Signals considered"). Team-level only: nothing
// is per person, and nothing is grouped by author. No composite score.
//
// Never a gate (spec D8): 0 whenever any dimension was assessed, whatever its
// value; 3 when none was (abstained, ADR 0009); 1 only for I/O (a named input
// that cannot be read, --out that cannot be written); 2 for usage.
//
// Invoked via `canary skills run canary-batgirl -- [flags]`.

import {
  createParser,
  formatUsageError,
  EXIT_USAGE,
} from '../../../lib/parse-args.mjs';
import { isMain } from '../../../lib/is-main.mjs';
import { gather } from './inputs.mjs';
import { produce, writeArtifact } from './output.mjs';
import { plain } from './text.mjs';

const PREFIX = 'canary-batgirl:';

/** Exit code reserved family-wide for "abstained" (ADR 0009). */
const EXIT_ABSTAINED = 3;

const USAGE =
  'usage: canary-batgirl [-h] [--escapes PATH] [--guardian PATH]\n' +
  '                      [--batwoman PATH] [--ledger PATH]\n' +
  '                      [--cassandra PATH] [--history PATH]\n' +
  '                      [--branch NAME] [--json] [--out PATH]\n' +
  '\n' +
  'Team quality scorecard. Six dimensions read from evidence other canary\n' +
  'tools record, each chosen because adding green tests cannot raise it.\n' +
  'Team-level only, no composite, report only: never a gate.\n' +
  '\n' +
  'options:\n' +
  '  -h, --help        show this help message and exit\n' +
  '  --escapes PATH    escape log (default: .canary/escapes.json)\n' +
  '  --guardian PATH   guardian records (default: .harness/analyses)\n' +
  '  --batwoman PATH   batwoman --json report, or a directory of them\n' +
  '  --ledger PATH     katana ledger (default: .canary/quarantine.json)\n' +
  '  --cassandra PATH  canary-cassandra --json report\n' +
  '  --history PATH    run-history store\n' +
  '                    (default: test-results/reports/history-v2.jsonl)\n' +
  '  --branch NAME     mainline branch for red commits (default: main)\n' +
  '  --json            print the JSON report instead of Markdown\n' +
  '  --out PATH        also write the printed report to PATH\n' +
  '\n' +
  'Every path is read inside the working directory; symlinks are not\n' +
  'followed.\n' +
  '\n' +
  'exit: 0 report printed, 3 no dimension assessed (abstained), 1 I/O\n' +
  'error, 2 usage. Values never change the exit code.';

// No parser default for the six inputs ON PURPOSE: null is how inputs.mjs
// tells a dark default path from a typo'd named one (canary-ivy's device).
export const CLI_SPEC = {
  prog: 'canary-batgirl',
  booleans: { '--json': 'json' },
  values: {
    '--escapes': { key: 'escapes' },
    '--guardian': { key: 'guardian' },
    '--batwoman': { key: 'batwoman' },
    '--ledger': { key: 'ledger' },
    '--cassandra': { key: 'cassandra' },
    '--history': { key: 'history' },
    '--branch': { key: 'branch' },
    '--out': { key: 'out' },
  },
  defaults: { branch: 'main' },
};

const parseArgs = createParser(CLI_SPEC);

function fail(message) {
  console.error(`${PREFIX} ${plain(message, 400)}`);
  return 1;
}

export function main(argv = []) {
  const { opts: args, help, error } = parseArgs(argv);
  if (help) {
    console.log(USAGE);
    return 0;
  }
  if (error) {
    console.error(formatUsageError(CLI_SPEC.prog, plain(error, 400)));
    return EXIT_USAGE;
  }
  const { inputs, error: readError } = gather(args);
  if (readError) return fail(readError);
  const { abstained, text } = produce(inputs, args);
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
