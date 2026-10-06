#!/usr/bin/env node
// canary-starling -- compose a canary.site/1 feed (#1151 phase 2).
//
// Reads what canary already persists -- the run-history store, canary.run/1
// files, the katana ledger, a `canary ci-ready --json` report, and any
// canary.assessment/1 files -- and writes one site.json a page loads in one
// fetch. The feed is validated before it is written; an invalid feed is
// never written (exit 1). Every input it could not use is named on stderr.
//
// Exit: 0 written · 1 read error or invalid feed · 2 usage · 3 under
// --strict when the feed carries zero runs (#508 D4).
//
// Invoked via `canary skills run canary-starling -- --config <file> --out <file> [...]`.

import fs from 'node:fs';
import path from 'node:path';

import {
  createParser,
  formatUsageError,
  EXIT_USAGE,
} from '../../../lib/parse-args.mjs';
import { isMain } from '../../../lib/is-main.mjs';
import { composeFeed, gatherInputs } from './feed.mjs';

const PREFIX = 'canary-starling:';
const EXIT_ABSTAINED = 3;

const USAGE =
  'usage: canary-starling [-h] --config PATH --out PATH [--history PATH]\n' +
  '                       [--ledger PATH] [--ci-ready PATH] [--strict]\n' +
  '                       [RECORD ...]\n' +
  '\n' +
  'Compose a validated canary.site/1 feed. RECORD: canary.run/1 or\n' +
  'canary.assessment/1 JSON files.';

export const CLI_SPEC = {
  prog: 'canary-starling',
  booleans: { '--strict': 'strict' },
  values: {
    '--config': { key: 'config' },
    '--out': { key: 'out' },
    '--history': { key: 'history' },
    '--ledger': { key: 'ledger' },
    '--ci-ready': { key: 'ciReady' },
  },
  defaults: {},
  required: ['--config', '--out'],
  positionals: { key: 'records' },
};

const parseArgs = createParser(CLI_SPEC);

/** Writes the feed; returns why it could not, or null. */
function write(out, doc) {
  try {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    return null;
  } catch (exc) {
    return `cannot write ${out}: ${exc.message}`;
  }
}

/** The written feed's one-line summary; the exit code. */
function summarize(args, doc) {
  if (doc.runs.length === 0) {
    // A feed of zero runs reads as "all quiet" on a page. It measured nothing.
    console.log(
      `${PREFIX} ABSTAINED: wrote ${args.out} with 0 runs; the feed measured nothing.`,
    );
    return args.strict ? EXIT_ABSTAINED : 0;
  }
  console.log(
    `${PREFIX} wrote ${args.out}: ${doc.runs.length} run(s), ${doc.assessments.length} assessment(s), ${doc.flaky.length} flaky, ${doc.register.length} register row(s)`,
  );
  return 0;
}

export function main(argv = []) {
  const { opts: args, positionals, help, error } = parseArgs(argv);
  if (help) {
    console.log(USAGE);
    return 0;
  }
  if (error) {
    console.error(formatUsageError(CLI_SPEC.prog, error));
    return EXIT_USAGE;
  }
  const now = new Date().toISOString();
  const notes = [];
  let parts;
  try {
    parts = gatherInputs({ ...args, records: positionals }, notes, now);
  } catch (exc) {
    console.error(`${PREFIX} ${exc.message}`);
    return 1;
  }
  for (const n of notes) console.error(`${PREFIX} ${n}`);
  const { doc, errors } = composeFeed({ ...parts, now });
  if (errors.length) {
    for (const e of errors)
      console.error(`${PREFIX} invalid feed: ${e.path}: ${e.message}`);
    console.error(`${PREFIX} ${args.out} not written`);
    return 1;
  }
  const failed = write(args.out, doc);
  if (failed) {
    console.error(`${PREFIX} ${failed}`);
    return 1;
  }
  return summarize(args, doc);
}

// `process.exitCode`, not `process.exit()` (#791).
if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
