#!/usr/bin/env node
// canary-hawk-dove -- outcome labels for past gate findings (#618, slice).
//
// The threshold auto-tuner #618 asks for is blocked on one thing: nobody
// records whether a past finding was real. This slice records it. `record`
// takes a gate's JSON into an append-only ledger and derives the labels the
// team already leaves (ADR 0025); `label` and `escape` are the single CLI step
// a person takes when no signal exists; `report` prints the observed counts
// per gate. It never tunes, and never prints a threshold.
//
// Exit codes:
//   0  done (report: at least one gate reached the 30-label floor)
//   1  the ledger or --out could not be written
//   2  usage error, unreadable input, or a rejected label (unknown id)
//   3  report abstained (ADR 0009): no gate reached the floor
//
// Invoked via `canary skills run canary-hawk-dove -- <command> ...`.

import {
  createParser,
  formatUsageError,
  EXIT_USAGE,
} from '../../../lib/parse-args.mjs';
import { isMain } from '../../../lib/is-main.mjs';
import { addEscape, addLabel, record } from './write.mjs';
import { report } from './read.mjs';

// The ledger path is spelled here rather than imported from ledger.mjs, which
// would be a fifth import (the perf ratchet's coupling rule).
const DEFAULT_LEDGER = '.canary/hawk-dove/ledger.jsonl';

const USAGE =
  'usage: canary-hawk-dove <command> [options]\n' +
  '\n' +
  'Outcome labels for past gate findings. Counts only: no threshold is\n' +
  'tuned or proposed (#618).\n' +
  '\n' +
  'commands:\n' +
  '  record --gate G --from FILE [--pr N] [--by WHO]\n' +
  "                  take a gate run's JSON into the ledger; derive labels\n" +
  '  label ID --outcome real|noise|intentional --by WHO --evidence REF\n' +
  '                  label one recorded finding (unknown ids are rejected)\n' +
  '  escape --gate G --by WHO --evidence REF\n' +
  '                  record a defect the gate missed\n' +
  '  report [--json] [--out PATH]\n' +
  '                  per-gate counts; exits 3 below 30 adjudicated labels\n' +
  '\n' +
  'options:\n' +
  '  -h, --help      show this help message and exit\n' +
  '  --repo DIR      repository root (default: the current directory)\n' +
  `  --ledger PATH   ledger inside the repository (default: ${DEFAULT_LEDGER})\n` +
  '  --note TEXT     free-text note on a label or escape\n' +
  '  --at ISO        provenance time (default: now)';

export const CLI_SPEC = {
  prog: 'canary-hawk-dove',
  booleans: { '--json': 'json' },
  values: {
    '--repo': { key: 'repo' },
    '--ledger': { key: 'ledger' },
    '--out': { key: 'out' },
    '--gate': { key: 'gate' },
    '--from': { key: 'from' },
    '--pr': { key: 'pr', type: 'int' },
    '--by': { key: 'by' },
    '--outcome': { key: 'outcome' },
    '--evidence': { key: 'evidence' },
    '--note': { key: 'note' },
    '--at': { key: 'at' },
  },
  defaults: { repo: '.', ledger: DEFAULT_LEDGER },
  positionals: { key: 'args' },
};

const COMMANDS = { record, label: addLabel, escape: addEscape, report };

// Which options each command reads; any other one is a usage error rather
// than silently ignored.
const ALLOWED = {
  record: ['gate', 'from', 'pr', 'by', 'at'],
  label: ['outcome', 'by', 'evidence', 'note', 'at'],
  escape: ['gate', 'by', 'evidence', 'note', 'at'],
  report: ['json', 'out'],
};
const COMMON = ['repo', 'ledger'];

const parseArgs = createParser(CLI_SPEC);

const FLAG_OF = Object.fromEntries(
  Object.entries(CLI_SPEC.values).map(([flag, { key }]) => [key, flag]),
);

/** The first option this command does not read, as its flag. */
function strayOption(command, opts) {
  const allowed = new Set([...COMMON, ...ALLOWED[command]]);
  const stray = Object.keys(opts).find(
    (k) => opts[k] != null && opts[k] !== false && !allowed.has(k),
  );
  return stray ? (FLAG_OF[stray] ?? `--${stray}`) : null;
}

function resolve(argv) {
  const { opts, positionals, help, error } = parseArgs(argv);
  if (help || error) return { help, error };
  const command = positionals[0];
  if (!command)
    return { error: 'expected a command: record, label, escape or report' };
  if (!Object.hasOwn(COMMANDS, command)) {
    return {
      error: `unknown command (choose from ${Object.keys(COMMANDS).join(', ')})`,
    };
  }
  const stray = strayOption(command, opts);
  if (stray) return { error: `argument ${stray}: not used by ${command}` };
  return { command, opts: { ...opts, args: positionals } };
}

/**
 * @param {string[]} argv
 * @param {{now?: () => Date}} [deps]
 * @returns {number}
 */
export function main(argv = [], deps = {}) {
  const { help, error, command, opts } = resolve(argv);
  if (help) {
    console.log(USAGE);
    return 0;
  }
  const res = error
    ? { usage: error }
    : COMMANDS[command](opts, { now: deps.now ?? (() => new Date()) });
  if (res.usage) {
    console.error(formatUsageError(CLI_SPEC.prog, res.usage));
    return EXIT_USAGE;
  }
  return res.code;
}

// `process.exitCode`, not `process.exit()`: a large report can exceed the
// pipe buffer, and `process.exit` would truncate it mid-write (#791).
if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
