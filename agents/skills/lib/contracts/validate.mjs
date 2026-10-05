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
