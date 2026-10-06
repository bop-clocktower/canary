#!/usr/bin/env node
// canary-signal -- QA impact digest (#609).
//
// Reads what canary already persists -- the run-history store and the katana
// quarantine ledger -- and emits a digest of what testing caught in a window,
// so the work of testing is legible to people who do not open the code
// (STRATEGY.md, "Quality made legible").
//
// It emits. It does not post: no Slack, no Teams, no webhook, no network.
// Output is markdown on stdout (with a chat-ready block inside it) and, with
// --out, the same markdown on disk -- the same contract as canary-screech.
//
// Advisory by default (#508 D3): exit 0. Under --strict: 3 = abstained (zero
// runs in the window), 0 otherwise. There is no exit 1 "red" state -- a
// digest has nothing to fail on. Read errors exit 1, usage errors 2.
//
// Invoked via `canary skills run canary-signal -- --history <jsonl> [...]`.

import fs from 'node:fs';
import path from 'node:path';

import {
  createParser,
  formatUsageError,
  EXIT_USAGE,
} from '../../../lib/parse-args.mjs';
import { DEFAULT_LEDGER, loadLedger, loadRuns } from './sources.mjs';
import { resolveWindow } from './window.mjs';
import { tallyDigest } from './tally.mjs';
import { renderDigest } from './digest.mjs';
import { isMain } from '../../../lib/is-main.mjs';

const PREFIX = 'canary-signal:';

/** Exit code reserved family-wide for "abstained" (#508 D4). */
const EXIT_ABSTAINED = 3;

const USAGE =
  'usage: canary-signal [-h] --history PATH [--ledger PATH] [--branch NAME]\n' +
  '                     [--days N] [--until ISO] [--out PATH] [--strict]\n' +
  '\n' +
  'QA impact digest: what testing caught, every number beside its denominator.';

// `--ledger` has no default ON PURPOSE: null is how main knows the caller did
// not name one, which separates a dark source from a typo (spec D10).
export const CLI_SPEC = {
  prog: 'canary-signal',
  booleans: { '--strict': 'strict' },
  values: {
    '--history': { key: 'history' },
    '--ledger': { key: 'ledger' },
    '--branch': { key: 'branch' },
    '--days': { key: 'days', type: 'int' },
    '--until': { key: 'until' },
    '--out': { key: 'out' },
  },
  defaults: { branch: 'main', days: 7 },
  required: ['--history'],
};

const parseArgs = createParser(CLI_SPEC);

/** @returns {string|null} null on success */
function writeArtifact(out, markdown) {
  try {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, markdown, 'utf8');
    return null;
  } catch (exc) {
    return `cannot write artifact: ${exc.message}`;
  }
}

function loadSources(args) {
  try {
    return {
      runs: loadRuns(args.history),
      ledger: loadLedger(args.ledger ?? DEFAULT_LEDGER, args.ledger !== null),
    };
  } catch (exc) {
    return { error: exc.message };
  }
}

function usageError(message) {
  console.error(formatUsageError(CLI_SPEC.prog, message));
  return EXIT_USAGE;
}

function emit(args, tally) {
  const { markdown } = renderDigest(tally);
  console.log(markdown);
  const failure = args.out ? writeArtifact(args.out, markdown) : null;
  if (failure) {
    console.error(`${PREFIX} ${failure}`);
    return 1;
  }
  return args.strict && tally.state === 'abstained' ? EXIT_ABSTAINED : 0;
}

export function main(argv = []) {
  const { opts: args, help, error } = parseArgs(argv);
  if (help) {
    console.log(USAGE);
    return 0;
  }
  if (error) return usageError(error);
  const resolved = resolveWindow(args.days, args.until);
  if (resolved.error) return usageError(resolved.error);
  const sources = loadSources(args);
  if (sources.error) {
    console.error(`${PREFIX} ${sources.error}`);
    return 1;
  }
  const tally = tallyDigest({
    runs: sources.runs,
    ledger: sources.ledger,
    branch: args.branch,
    window: resolved.window,
  });
  return emit(args, tally);
}

// `process.exitCode`, not `process.exit()`: a large payload exceeds the pipe
// buffer and `process.exit` truncates it while still exiting 0 (#791).
if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
