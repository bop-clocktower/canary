// The canary QA data contract validator's API (#1151, ADR 0035):
// validateDocument and validateText for canary.run/1, canary.assessment/1 and
// canary.site/1. validate.mjs is the CLI over this module and re-exports it.
//
// Split from validate.mjs so a producer (canary-starling) imports the API
// without the CLI's argument parsing and entry guard: as one module, every
// importer pushed validate.mjs over the perf coupling-ratio threshold.
//
// Zero dependencies. Schema-driven: the three *.v1.schema.json files beside
// this module ARE the contract, interpreted by schema-check.mjs. Anything they
// cannot express is a named rule in rules.mjs. Errors are {path, message}; the
// document root is `$`.

import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

import { auditedValidator } from './schema-problems.mjs';
import { crossFieldErrors } from './rules.mjs';

export const LAYERS = ['run', 'assessment', 'site'];
const SUPPORTED_MAJOR = 1;
const CONTRACT_RE = /^canary\.([a-z]+)\/(\d+)$/;

const schemaId = (layer) => `${layer}.v1.schema.json`;

/** One leading U+FEFF is an encoding marker, not JSON (#1154 S7). */
const stripBom = (text) => (text.startsWith('\uFEFF') ? text.slice(1) : text);

function loadRegistry() {
  const registry = Object.create(null);
  for (const layer of LAYERS) {
    const url = new URL(`./${schemaId(layer)}`, import.meta.url);
    registry[schemaId(layer)] = JSON.parse(readFileSync(url, 'utf8'));
  }
  return registry;
}

// Throws at import over any schema that would enforce less than it reads as
// enforcing, so the CLI and the API both refuse to run at all.
const checkSchema = auditedValidator(loadRegistry());

/** null for a JSON object; otherwise what the document is instead. */
function notAnObject(doc) {
  if (doc === null) return 'null';
  if (Array.isArray(doc)) return 'array';
  return typeof doc === 'object' ? null : typeof doc;
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

/**
 * A site feed's nested arrays whose rows are validated records (#1154 S8).
 * `scopes[]` and `suites[]` are keys records refer to, so they are not counted.
 */
const SITE_RECORD_KEYS = ['runs', 'assessments', 'flaky', 'register'];

/** The denominator: documents plus the records nested in a site feed. */
function countRecords(layer, doc) {
  if (layer !== 'site') return 1;
  const len = (key) => (Array.isArray(doc[key]) ? doc[key].length : 0);
  return SITE_RECORD_KEYS.reduce((n, key) => n + len(key), 1);
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
  const got = notAnObject(doc);
  if (got !== null) {
    return verdict(
      null,
      [{ path: '$', message: `expected a JSON object, got ${got}` }],
      1,
    );
  }
  const claim = readContract(doc, opts.layer ?? null);
  if (claim.error) return verdict(null, [claim.error], 1);
  const errors = [
    ...checkSchema(schemaId(claim.layer), doc),
    ...crossFieldErrors(claim.layer, doc),
  ];
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
    doc = JSON.parse(stripBom(text));
  } catch (err) {
    return verdict(
      null,
      [{ path: '$', message: `not parseable JSON: ${err.message}` }],
      0,
    );
  }
  return validateDocument(doc, opts);
}
