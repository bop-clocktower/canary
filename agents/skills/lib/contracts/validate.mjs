#!/usr/bin/env node
// Validator for the canary QA data contract (#1151, ADR 0035):
// canary.run/1, canary.assessment/1, canary.site/1.
//
// Zero dependencies, so a producer's CI or site-deploy.yml can run it from
// the shipped skills tree with nothing installed. This file is the CLI; the
// API (validateDocument, validateText) lives in document.mjs and is
// re-exported here, so existing importers are unchanged.
//
// Exit codes (CLI): 0 valid, 1 refused (invalid OR unparseable; a parse
// failure is never a pass), 2 usage or unreadable input. There is no exit 3:
// a parsed document always has a denominator of at least 1 (fork N).

import { readFileSync } from 'node:fs';
import process from 'node:process';

import { isMain } from '../is-main.mjs';
import { createParser, EXIT_USAGE, formatUsageError } from '../parse-args.mjs';
import { LAYERS, validateDocument, validateText } from './document.mjs';

export { validateDocument, validateText };

const PROG = 'canary-contracts-validate';

const HELP = `usage: ${PROG} [-h] [--layer {run,assessment,site}] [--json] [file]

Validate one canary QA contract document (canary.run/1, canary.assessment/1,
canary.site/1). Reads stdin when file is omitted or '-'.

exit codes: 0 valid · 1 refused (invalid or unparseable) · 2 usage or unreadable file/stdin`;

const parse = createParser({
  prog: PROG,
  booleans: { '--json': 'json' },
  values: { '--layer': { key: 'layer' } },
  positionals: { key: 'files' },
});

function argsProblem(parsed) {
  if (parsed.error) return parsed.error;
  if (parsed.positionals.length > 1) {
    return `unrecognized arguments: ${parsed.positionals.slice(1).join(' ')}`;
  }
  const { layer } = parsed.opts;
  if (layer !== null && !LAYERS.includes(layer)) {
    return `argument --layer: invalid choice: '${layer}' (choose from ${LAYERS.join(', ')})`;
  }
  return null;
}

/** An unreadable input (a file, or stdin redirected from a directory) is exit 2. */
function readInput(file, readStdin) {
  const fromStdin = file === undefined || file === '-';
  try {
    return { text: fromStdin ? readStdin() : readFileSync(file, 'utf8') };
  } catch (err) {
    const what = fromStdin ? 'stdin' : file;
    return { error: `cannot read ${what}: ${err.code ?? err.message}` };
  }
}

function printVerdict(res, json) {
  if (json) {
    console.log(JSON.stringify(res));
  } else if (res.valid) {
    const noun = res.checked === 1 ? 'record' : 'records';
    console.log(
      `valid ${res.contract}: ${res.checked} ${noun} checked, 0 errors`,
    );
  } else {
    for (const e of res.errors) console.error(`${e.path}: ${e.message}`);
    console.error(`refused: ${res.errors.length} error(s)`);
  }
}

/**
 * @param {string[]} [argv]
 * @param {{readStdin?: () => string}} [io] injectable for in-process tests
 * @returns {number} exit code
 */
export function main(argv = process.argv.slice(2), io = {}) {
  const readStdin = io.readStdin ?? (() => readFileSync(0, 'utf8'));
  const parsed = parse(argv);
  if (parsed.help) {
    console.log(HELP);
    return 0;
  }
  const problem = argsProblem(parsed);
  const input = problem ? null : readInput(parsed.positionals[0], readStdin);
  const usage = problem ?? input.error;
  if (usage) {
    console.error(formatUsageError(PROG, usage));
    return EXIT_USAGE;
  }
  const res = validateText(input.text, { layer: parsed.opts.layer });
  printVerdict(res, parsed.opts.json);
  return res.valid ? 0 : 1;
}

// `process.exitCode`, not `process.exit()`: exit tears the process down
// mid-write and truncates a large piped --json payload (#791).
if (isMain(import.meta.url)) {
  process.exitCode = main();
}
