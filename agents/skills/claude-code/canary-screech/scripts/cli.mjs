#!/usr/bin/env node
// canary-screech -- broken-main siren (#591).
//
// The cross-run member of the failure-surfacing family. canary-fail-fast aborts
// inside one run; canary-test-reporter summarises one run; neither can say the
// default branch went red, because that fact only exists in the SEQUENCE of
// runs. This skill reads that sequence out of the run-history store and emits a
// one-page blast: culprit commit range, failure cluster, owning area, a
// quarantine-or-revert recommendation, and a chat-ready block.
//
// It emits. It does not post: no Slack, no Teams, no webhook, no `gh`. Output
// is a markdown artifact (--out) plus a `::error` GitHub Actions annotation,
// the same channel canary-fail-fast uses.
//
// Advisory by default (#508 D3): exit 0 whatever it finds, unless --strict.
// Under --strict: 1 = red, 3 = abstained (zero runs for the branch), 0 = green.
//
// Invoked via `canary skills run canary-screech -- --history <jsonl> [...]`.

import fs from 'node:fs';
import path from 'node:path';

import {
  createParser,
  formatUsageError,
  EXIT_USAGE,
} from '../../../lib/parse-args.mjs';
import { loadRuns, runsForBranch } from './history.mjs';
import { assessBranch } from './redness.mjs';
import { clusterFailures } from './cluster.mjs';
import { renderBlast } from './blast.mjs';

const PREFIX = 'canary-screech:';

/** Exit code reserved family-wide for "abstained" (#508 D4). */
const EXIT_ABSTAINED = 3;

const USAGE =
  'usage: canary-screech [-h] --history PATH [--branch NAME] [--out PATH] [--strict]\n' +
  '\n' +
  'Broken-main siren: one-page blast when the default branch goes red.';

export const CLI_SPEC = {
  prog: 'canary-screech',
  booleans: { '--strict': 'strict' },
  values: {
    '--history': { key: 'history' },
    '--branch': { key: 'branch' },
    '--out': { key: 'out' },
  },
  defaults: { branch: 'main' },
  required: ['--history'],
};

const parseArgs = createParser(CLI_SPEC);

/**
 * Write the artifact, or return the message explaining why it could not be.
 * Extracted so `main` stays under the complexity the perf gate allows.
 *
 * @returns {string|null} null on success
 */
function writeArtifact(out, markdown) {
  try {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, markdown, 'utf8');
    return null;
  } catch (exc) {
    return `cannot write artifact: ${exc.message}`;
  }
}

/** The `--strict` exit contract. Advisory callers never reach this. */
function strictExitFor(state) {
  if (state === 'abstained') return EXIT_ABSTAINED;
  return state === 'red' ? 1 : 0;
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

  let runs;
  try {
    runs = runsForBranch(loadRuns(args.history), args.branch);
  } catch (exc) {
    // A bad --history path is an error, never "the branch looks fine".
    console.error(`${PREFIX} ${exc.message}`);
    return 1;
  }

  const assessment = assessBranch(runs);
  const cluster =
    assessment.state === 'red'
      ? clusterFailures(assessment.firstRed, assessment.culpritRange)
      : null;
  const blast = renderBlast({ branch: args.branch, assessment, cluster });

  console.log(blast.markdown);
  for (const annotation of blast.annotations) console.log(annotation);

  if (args.out) {
    const failure = writeArtifact(args.out, blast.markdown);
    if (failure) {
      console.error(`${PREFIX} ${failure}`);
      return 1;
    }
  }

  return args.strict ? strictExitFor(assessment.state) : 0;
}

// Direct execution (the skill runner execs this file via its shebang).
//
// `process.exitCode`, not `process.exit()`: a large payload exceeds the pipe
// buffer, and `process.exit` tears the process down mid-write, leaving
// truncated output that still exits 0 (#791).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
