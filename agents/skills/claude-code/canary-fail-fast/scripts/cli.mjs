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

import { parseFailures } from './parse.mjs';
import { buildDigest } from './digest.mjs';
import { checkConfig } from './fastfail_check.mjs';

const PREFIX = 'canary-fail-fast:';
const DASH = '\u2014'; // em dash (see digest.mjs)

const USAGE =
  'usage: canary-fail-fast [-h] [--results PATH] [--config PATH]\n' +
  '\n' +
  'Fail-fast config audit + loud run-end failure digest.';

// Null-prototype: on a plain object literal every inherited key resolves
// truthy, so `VALUE_FLAGS['toString']` would be Object.prototype.toString and
// the token `toString` would be swallowed as a value flag instead of rejected.
const VALUE_FLAGS = Object.assign(Object.create(null), {
  '--results': 'results',
  '--config': 'config',
});

/**
 * Match argparse's contract for the two exit paths the hand-rolled loop must
 * honour: `--help`/`-h` prints usage and exits 0; any parse error (unknown flag,
 * or a value-flag missing its argument) exits 2. On success returns the parsed
 * options. We deliberately do NOT replicate argparse's prefix-abbreviation
 * (`--res` for `--results`) -- an intentional simplification, consistent with
 * the canary-instrument port. `--flag=value` is supported.
 */
function parseArgs(argv) {
  const opts = { results: null, config: null, help: false, error: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      opts.help = true;
      return opts;
    }

    // `--flag=value`
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq !== -1) {
      const key = VALUE_FLAGS[a.slice(0, eq)];
      if (!key) {
        opts.error = `unrecognized arguments: ${a}`;
        return opts;
      }
      opts[key] = a.slice(eq + 1);
      continue;
    }

    // `--flag value`
    const key = VALUE_FLAGS[a];
    if (!key) {
      opts.error = `unrecognized arguments: ${a}`;
      return opts;
    }
    const next = argv[i + 1];
    // A value is required; argparse errors when it is missing or looks like
    // another option (starts with '-').
    if (next === undefined || next.startsWith('-')) {
      opts.error = `argument ${a}: expected one argument`;
      return opts;
    }
    opts[key] = next;
    i += 1;
  }
  return opts;
}

export function main(argv = []) {
  const args = parseArgs(argv);

  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.error) {
    console.error(`${PREFIX} ${args.error}`);
    return 2;
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
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
