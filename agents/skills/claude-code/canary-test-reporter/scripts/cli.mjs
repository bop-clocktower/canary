#!/usr/bin/env node
// canary-test-reporter -- Playwright JSON -> Markdown + JSON report. Ported
// behavior-for-behavior from the Python original.
//
//   --results <path>        required: Playwright JSON results file
//   --markdown-out <path>   write Markdown report to file (stdout if neither
//                           --markdown-out nor --json-out is given)
//   --json-out <path>       write JSON report to file
//
// Exit code: 1 when any test failed, else 0.
//
// Invoked via `canary skills run canary-test-reporter -- --results <json>`.

import fs from 'node:fs';

import {
  createParser,
  formatUsageError,
  EXIT_USAGE,
} from '../../../lib/parse-args.mjs';
import { parseResults } from './parse.mjs';
import { renderMarkdown } from './render.mjs';
import { renderJson } from './json_report.mjs';

const PREFIX = 'canary-test-reporter:';

const USAGE =
  'usage: canary-test-reporter [-h] --results PATH [--markdown-out PATH]\n' +
  '                            [--json-out PATH]\n' +
  '\n' +
  'Playwright JSON results -> Markdown + JSON test report.';

/**
 * `--results` is required; the optional writers default to null so main can
 * tell "not asked for" from "asked for, empty". The four shared invariants live
 * in the shared parser (#479).
 */
export const CLI_SPEC = {
  prog: 'canary-test-reporter',
  values: {
    '--results': { key: 'results' },
    '--markdown-out': { key: 'markdownOut' },
    '--json-out': { key: 'jsonOut' },
  },
  required: ['--results'],
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

  if (!fs.existsSync(args.results)) {
    console.error(`${PREFIX} results file not found: ${args.results}`);
    return 1;
  }

  let data;
  try {
    data = parseResults(args.results);
  } catch (exc) {
    console.error(`${PREFIX} ${exc.message}`);
    return 1;
  }

  const markdown = renderMarkdown(data);

  if (args.markdownOut) {
    fs.writeFileSync(args.markdownOut, markdown, 'utf8');
  } else if (!args.jsonOut) {
    // Python `print(markdown, end="")` -- no trailing newline is added.
    process.stdout.write(markdown);
  }

  if (args.jsonOut) {
    fs.writeFileSync(args.jsonOut, renderJson(data), 'utf8');
  }

  return data.failed > 0 ? 1 : 0;
}

// Direct execution (the skill runner execs this file via its shebang).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
