#!/usr/bin/env node
// Validator for the canary QA data contract (#1151, ADR 0035):
// canary.run/1, canary.assessment/1, canary.site/1.
//
// Zero dependencies, so a producer's CI or site-deploy.yml can run it from
// the shipped skills tree with nothing installed. Schema-driven: the three
// *.v1.schema.json files beside this module ARE the contract, interpreted by
// schema-check.mjs. Anything they cannot express is a named rule in
// rules.mjs. Errors are {path, message}; the document root is `$`.
//
// Exit codes (CLI): 0 valid, 1 refused (invalid OR unparseable; a parse
// failure is never a pass), 2 usage or unreadable file. There is no exit 3:
// a parsed document always has a denominator of at least 1 (fork N).

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { createParser, EXIT_USAGE, formatUsageError } from '../parse-args.mjs';
import { checkValue, isPlainObject, schemaProblems } from './schema-check.mjs';
import { crossFieldErrors } from './rules.mjs';

const LAYERS = ['run', 'assessment', 'site'];
const SUPPORTED_MAJOR = 1;
const CONTRACT_RE = /^canary\.([a-z]+)\/(\d+)$/;

const schemaId = (layer) => `${layer}.v1.schema.json`;

function loadRegistry() {
  const registry = Object.create(null);
  for (const layer of LAYERS) {
    const url = new URL(`./${schemaId(layer)}`, import.meta.url);
    registry[schemaId(layer)] = JSON.parse(readFileSync(url, 'utf8'));
  }
  return registry;
}

const REGISTRY = loadRegistry();

// Refuse to run at all over a schema that uses a keyword nothing enforces:
// a validator that silently skips part of its contract is a false green.
const PROBLEMS = schemaProblems(REGISTRY);
if (PROBLEMS.length > 0) {
  throw new Error(
    `canary contracts: unenforceable schema: ${PROBLEMS.join('; ')}`,
  );
}

const contractError = (message) => ({
  error: { path: 'contract', message },
});

/** Which layer a document claims, or the error that refuses the claim. */
function readContract(doc, expected) {
  if (!Object.hasOwn(doc, 'contract')) {
    return contractError('missing required field');
  }
  const m =
    typeof doc.contract === 'string' ? CONTRACT_RE.exec(doc.contract) : null;
  if (m === null) {
    return contractError(
      `not a canary contract string: ${JSON.stringify(doc.contract)}`,
    );
  }
  const [, layer, major] = m;
  if (!LAYERS.includes(layer)) return contractError(`unknown layer '${layer}'`);
  if (Number(major) !== SUPPORTED_MAJOR) {
    return contractError(
      `unknown major version ${major} for canary.${layer}; this reader supports ${SUPPORTED_MAJOR}`,
    );
  }
  if (expected && layer !== expected) {
    return contractError(`expected canary.${expected}/1, got ${doc.contract}`);
  }
  return { layer };
}

/** The denominator: documents plus the records nested in a site feed. */
function countRecords(layer, doc) {
  if (layer !== 'site') return 1;
  const len = (key) => (Array.isArray(doc[key]) ? doc[key].length : 0);
  return 1 + len('runs') + len('assessments');
}

function verdict(layer, errors, checked) {
  return {
    valid: errors.length === 0,
    contract: layer ? `canary.${layer}/${SUPPORTED_MAJOR}` : null,
    checked,
    errors,
  };
}

/**
 * Validate one parsed document.
 * @param {unknown} doc
 * @param {{layer?: string|null}} [opts] refuse a document of any other layer
 * @returns {{valid: boolean, contract: string|null, checked: number, errors: {path: string, message: string}[]}}
 */
export function validateDocument(doc, opts = {}) {
  if (!isPlainObject(doc)) {
    const got =
      doc === null ? 'null' : Array.isArray(doc) ? 'array' : typeof doc;
    return verdict(
      null,
      [{ path: '$', message: `expected a JSON object, got ${got}` }],
      1,
    );
  }
  const claim = readContract(doc, opts.layer ?? null);
  if (claim.error) return verdict(null, [claim.error], 1);
  const ctx = {
    registry: REGISTRY,
    base: schemaId(claim.layer),
    errors: [],
  };
  checkValue(REGISTRY[ctx.base], doc, '$', ctx);
  const errors = [...ctx.errors, ...crossFieldErrors(claim.layer, doc)];
  return verdict(claim.layer, errors, countRecords(claim.layer, doc));
}

/**
 * Validate raw text. Unparseable or empty input is a refusal (criterion 18).
 * @param {string} text
 * @param {{layer?: string|null}} [opts]
 */
export function validateText(text, opts = {}) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return verdict(
      null,
      [{ path: '$', message: `not parseable JSON: ${err.message}` }],
      0,
    );
  }
  return validateDocument(doc, opts);
}

const PROG = 'canary-contracts-validate';

const HELP = `usage: ${PROG} [-h] [--layer {run,assessment,site}] [--json] [file]

Validate one canary QA contract document (canary.run/1, canary.assessment/1,
canary.site/1). Reads stdin when file is omitted or '-'.

exit codes: 0 valid · 1 refused (invalid or unparseable) · 2 usage or unreadable file`;

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

function readInput(file, readStdin) {
  if (file === undefined || file === '-') return { text: readStdin() };
  try {
    return { text: readFileSync(file, 'utf8') };
  } catch (err) {
    return { error: `cannot read ${file}: ${err.code ?? err.message}` };
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
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = main();
}
