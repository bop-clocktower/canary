// ingest -- read axe-core JSON off disk and normalise it (#594).
//
// The skill is a post-processor, so this module is the only place that touches
// input, and it touches NO network and NO browser. It accepts the three shapes
// the common producers emit (@axe-core/playwright, jest-axe, the axe CLI):
//
//   - a single AxeResults object
//   - an array of them (one per URL)
//   - a { results: [...] } envelope
//
// It also computes the denominator the abstention rule needs (#594 D5). An axe
// document with `violations: []` means "clean" only if axe actually evaluated
// something; `passes`, `incomplete` and `inapplicable` are what prove it did.
// Counting them is why this module reads arrays it otherwise has no use for.

import fs from 'node:fs';
import path from 'node:path';

/** The four arrays axe fills; their combined length is the rule denominator. */
const RESULT_ARRAYS = ['violations', 'passes', 'incomplete', 'inapplicable'];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Every `.json` file under a directory, or the file itself. */
function jsonFiles(target) {
  if (!fs.existsSync(target)) {
    throw new Error(`results path not found: ${target}`);
  }
  if (!fs.statSync(target).isDirectory()) return [target];
  return fs
    .readdirSync(target)
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .sort()
    .map((name) => path.join(target, name));
}

/** Pull the axe documents out of whichever of the three shapes this is. */
function documentsIn(parsed) {
  if (Array.isArray(parsed)) return parsed.filter(isObject);
  if (!isObject(parsed)) return [];
  if (Array.isArray(parsed.results)) return parsed.results.filter(isObject);
  // A bare object counts only when it looks like an axe result, so a config
  // file that wandered into the directory does not become a scanned "page".
  return RESULT_ARRAYS.some((key) => Array.isArray(parsed[key]))
    ? [parsed]
    : [];
}

function arrayAt(doc, key) {
  return Array.isArray(doc[key]) ? doc[key] : [];
}

/** One normalised document; `evaluated` is this page's slice of the denominator. */
function normalise(doc) {
  return {
    url: typeof doc.url === 'string' ? doc.url : null,
    violations: arrayAt(doc, 'violations').filter(isObject),
    evaluated: RESULT_ARRAYS.reduce(
      (total, key) => total + arrayAt(doc, key).length,
      0,
    ),
  };
}

/**
 * @param {string} target a JSON file, or a directory of them
 * @returns {{documents: object[], ruleEvaluations: number, files: number}}
 * @throws {Error} naming the offending file when JSON cannot be parsed
 */
export function ingest(target) {
  const documents = [];
  const files = jsonFiles(target);

  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (exc) {
      throw new Error(`cannot parse ${file}: ${exc.message}`);
    }
    documents.push(...documentsIn(parsed).map(normalise));
  }

  return {
    documents,
    ruleEvaluations: documents.reduce((n, doc) => n + doc.evaluated, 0),
    files: files.length,
  };
}
