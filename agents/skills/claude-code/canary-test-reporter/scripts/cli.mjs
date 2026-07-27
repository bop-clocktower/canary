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

import { parseResults } from './parse.mjs';
import { renderMarkdown } from './render.mjs';
import { renderJson } from './json_report.mjs';

const PREFIX = 'canary-test-reporter:';

const USAGE =
  'usage: canary-test-reporter [-h] --results PATH [--markdown-out PATH]\n' +
  '                            [--json-out PATH]\n' +
  '\n' +
  'Playwright JSON results -> Markdown + JSON test report.';

const VALUE_FLAGS = {
  '--results': 'results',
  '--markdown-out': 'markdownOut',
  '--json-out': 'jsonOut',
};

/**
 * Hand-rolled argparse-parity parser. `--help`/`-h` prints usage and exits 0;
 * an unknown flag or a value-flag missing its argument exits 2; a missing
 * required `--results` exits 2. We deliberately do NOT replicate argparse's
 * prefix-abbreviation, consistent with the canary-fail-fast/instrument ports.
 * `--flag=value` is supported.
 */
function parseArgs(argv) {
  const opts = {
    results: null,
    markdownOut: null,
    jsonOut: null,
    help: false,
    error: null,
  };
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
  if (!args.results) {
    console.error(`${PREFIX} the following arguments are required: --results`);
    return 2;
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
