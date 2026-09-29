#!/usr/bin/env node
// canary-question -- test defect, product defect, or environment? (#613)
//
// For ONE failing test, assemble the evidence canary already persists (the
// run-history store, optionally a git diff of the culprit range and one Tier-0
// detector envelope) into a brief: three hypotheses in a fixed order, the
// evidence for and against each, what could not be read, and what would tell
// them apart. It never picks one. A wrong triage is worse than none: calling a
// real product defect a flaky test is how defects escape.
//
// Advisory only (D10): exit 0 for every brief, abstention included. 1 = a
// named input could not be read or --out could not be written. 2 = usage.
// There is no --strict: this tool must never fail a job on its own reading.
//
// Invoked via `canary skills run canary-question -- --test NAME [...]`.

import fs from 'node:fs';
import path from 'node:path';

import {
  createParser,
  formatUsageError,
  EXIT_USAGE,
} from '../../../lib/parse-args.mjs';
import {
  DEFAULT_HISTORY,
  buildTimeline,
  readStore,
  selectTarget,
} from './history.mjs';
import { diffEvidence } from './diff.mjs';
import { loadFindings } from './findings.mjs';
import {
  abstentionFor,
  assembleBrief,
  renderJson,
  renderMarkdown,
} from './brief.mjs';

const PREFIX = 'canary-question:';

const USAGE =
  'usage: canary-question [-h] --test NAME [--suite NAME] [--history PATH]\n' +
  '                       [--findings PATH] [--repo DIR] [--json] [--out PATH]\n' +
  '\n' +
  'Evidence brief for one failing test: test defect, product defect, or\n' +
  'environment -- the evidence for and against each. It does not choose.';

// `--history` has no default ON PURPOSE: null is how main tells a dark default
// store from a typo'd path (spec D9; same device as canary-signal --ledger).
export const CLI_SPEC = {
  prog: 'canary-question',
  booleans: { '--json': 'json' },
  values: {
    '--test': { key: 'test' },
    '--suite': { key: 'suite' },
    '--history': { key: 'history' },
    '--findings': { key: 'findings' },
    '--repo': { key: 'repo' },
    '--out': { key: 'out' },
  },
  defaults: { repo: '.' },
  required: ['--test'],
};

const parseArgs = createParser(CLI_SPEC);

/** @returns {string|null} null on success */
function writeArtifact(out, text) {
  try {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, text, 'utf8');
    return null;
  } catch (exc) {
    return `cannot write artifact: ${exc.message}`;
  }
}

function loadInputs(args) {
  try {
    return {
      store: readStore(args.history ?? DEFAULT_HISTORY, args.history !== null),
      findings: args.findings === null ? null : loadFindings(args.findings),
    };
  } catch (exc) {
    return { error: exc.message };
  }
}

/** Everything assembleBrief needs; the git diff is read only when not abstaining. */
function gather(args, { store, findings }) {
  const timeline = buildTimeline(store.runs, {
    test: args.test,
    suite: args.suite,
  });
  const { target, lastPass } = selectTarget(timeline.observations);
  const abstained = abstentionFor(timeline, target, args.suite);
  const diff = abstained
    ? null
    : diffEvidence({ repo: args.repo, target, lastPass });
  return {
    test: args.test,
    suite: args.suite,
    historyDark: store.dark,
    timeline,
    target,
    lastPass,
    abstained,
    diff,
    findings,
  };
}

function emit(args, brief) {
  const text = args.json ? renderJson(brief) : renderMarkdown(brief);
  console.log(text);
  const failure = args.out ? writeArtifact(args.out, text) : null;
  if (failure) {
    console.error(`${PREFIX} ${failure}`);
    return 1;
  }
  return 0;
}

export function main(argv = []) {
  const { opts: args, help, error } = parseArgs(argv);
  if (help) {
    console.log(USAGE);
    return 0;
  }
  if (error) {
    console.error(formatUsageError(CLI_SPEC.prog, error));
    return EXIT_USAGE;
  }
  const inputs = loadInputs(args);
  if (inputs.error) {
    console.error(`${PREFIX} ${inputs.error}`);
    return 1;
  }
  return emit(args, assembleBrief(gather(args, inputs)));
}

// `process.exitCode`, not `process.exit()`: a large payload exceeds the pipe
// buffer and `process.exit` truncates it while still exiting 0 (#791).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
