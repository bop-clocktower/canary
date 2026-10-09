// Validator for .canary/critical-areas.json (#1242): the high-risk areas
// canary-critical-areas writes and canary-katana alarms on.
//
// Schema-driven like the canary.* layers: critical-areas.v1.schema.json is the
// contract, interpreted by the same audited subset checker, so the file a
// producer reads is the file this enforces. It is a separate entry point and
// not a fourth layer because the document carries no `contract` field to
// dispatch on.
//
// Zero dependencies, and vendorable: nothing here touches a Node global.

import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

import { auditedValidator } from './schema-problems.mjs';

const ID = 'critical-areas.v1.schema.json';

const checkSchema = auditedValidator({
  [ID]: JSON.parse(readFileSync(new URL(`./${ID}`, import.meta.url), 'utf8')),
});

/** How katana compares a symbol with a test title: letters and digits only. */
export const normSymbol = (text) =>
  text.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * A declared symbol shorter than this, once normalized, matches far too many
 * test titles to mean anything (`a` is in nearly every one). Declared symbols
 * may be shorter than derived ones (4): someone chose them on purpose.
 */
export const MIN_DECLARED_SYMBOL = 3;

/**
 * What the schema subset cannot say about `symbols`: an empty list declares
 * nothing to match (omit the field to fall back to the basename), and a symbol
 * under MIN_DECLARED_SYMBOL letters or digits matches almost every title.
 */
function symbolErrors(areas) {
  return areas.flatMap((area, i) => areaSymbolErrors(area?.symbols, i));
}

/** A blank or non-string item is the schema's error, so it is skipped here. */
const tooShort = (s) =>
  typeof s === 'string' &&
  s.trim() !== '' &&
  normSymbol(s).length < MIN_DECLARED_SYMBOL;

const symbolError = (i, j) => ({
  path: `areas[${i}].symbols[${j}]`,
  message: `has under ${MIN_DECLARED_SYMBOL} letters or digits to match a test title on`,
});

function areaSymbolErrors(symbols, i) {
  if (!Array.isArray(symbols)) return [];
  if (symbols.length === 0) {
    return [
      {
        path: `areas[${i}].symbols`,
        message: 'is empty; omit it to match on the path basename instead',
      },
    ];
  }
  return symbols.flatMap((s, j) => (tooShort(s) ? [symbolError(i, j)] : []));
}

/**
 * Validate a parsed critical-areas document.
 * @param {unknown} doc
 * @returns {{valid: boolean, checked: number,
 *            errors: {path: string, message: string}[]}}
 *   `checked` is the number of areas read: the denominator a caller reports.
 */
export function validateCriticalAreas(doc) {
  const errors = checkSchema(ID, doc);
  const areas = Array.isArray(doc?.areas) ? doc.areas : [];
  errors.push(...symbolErrors(areas));
  return { valid: errors.length === 0, checked: areas.length, errors };
}
