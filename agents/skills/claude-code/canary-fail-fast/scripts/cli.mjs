#!/usr/bin/env node
// canary-fail-fast -- surface test failures fast and loud. Ported behavior-for-
// behavior from the Python original.
//
// Two halves:
//   --config <playwright.config.*>  audit fail-fast knobs (maxFailures/forbidOnly/
//                                   retries); print recommendations (read-only).
//   --results <playwright.json>     print a loud, categorized failure digest to
//                                   the CI log + ::error annotations; exit non-
//                                   zero on any failure so the step fails.
//
// At least one of --config / --results is required. Self-contained -- no
// external skill dependency.
//
// Invoked via `canary skills run canary-fail-fast -- --results <json> [--config <path>]`.

import fs from 'node:fs';

import {
  createParser,
  formatUsageError,
  EXIT_USAGE,
} from '../../../lib/parse-args.mjs';
import { parseFailures } from './parse.mjs';
import { buildDigest } from './digest.mjs';
import { checkConfig } from './fastfail_check.mjs';

const PREFIX = 'canary-fail-fast:';
const DASH = '\u2014'; // em dash (see digest.mjs)

const USAGE =
  'usage: canary-fail-fast [-h] [--results PATH] [--config PATH]\n' +
  '\n' +
  'Fail-fast config audit + loud run-end failure digest.';

/**
 * Both value flags are optional here -- main enforces "at least one of
 * --results / --config" itself, because argparse has no vocabulary for that.
 * The four shared invariants live in the shared parser (#479).
 */
export const CLI_SPEC = {
  prog: 'canary-fail-fast',
  values: {
    '--results': { key: 'results' },
    '--config': { key: 'config' },
  },
};

const parseArgs = createParser(CLI_SPEC);

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

  if (!args.results && !args.config) {
    console.error(
      `${PREFIX} nothing to do ${DASH} pass --results and/or --config.`,
    );
    return 1;
  }

  // ---- config audit -----------------------------------------------------
  if (args.config) {
    let text;
    try {
      text = fs.readFileSync(args.config, 'utf8');
    } catch (exc) {
      console.error(`${PREFIX} cannot read config: ${exc.message}`);
      return 1;
    }
    const recs = checkConfig(text);
    if (recs.length) {
      console.log('Fail-fast config recommendations:');
      for (const r of recs) console.log(`  - ${r}`);
    } else {
      console.log('Fail-fast config OK.');
    }
  }

  // ---- failure digest ---------------------------------------------------
  let exitCode = 0;
  if (args.results) {
    if (!fs.existsSync(args.results)) {
      console.error(`${PREFIX} results file not found: ${args.results}`);
      return 1;
    }
    let failures;
    try {
      failures = parseFailures(args.results);
    } catch (exc) {
      console.error(`${PREFIX} ${exc.message}`);
      return 1;
    }
    const d = buildDigest(failures);
    console.log(d.text);
    for (const ann of d.annotations) console.log(ann);
    exitCode = d.exitCode;
  }

  return exitCode;
}

// Direct execution (the skill runner execs this file via its shebang).
//
// `process.exitCode`, not `process.exit()`: a large `--json` payload exceeds
// the pipe buffer, and `process.exit` tears the process down mid-write, leaving
// truncated JSON that still exits 0 (#791).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
