// Validator for canary.tool-review/1 (ADR 0045): the report canary-blackalice
// writes after reviewing a QA tool from the seats of the people who use it.
//
// Schema-driven like the canary.* layers: tool-review.v1.schema.json is the
// contract, interpreted by the same audited subset checker. It is its own
// entry point, following critical-areas.mjs, and is not routed through
// document.mjs: that module's CONTRACT_RE admits no hyphen and its LAYERS are
// fixed to run/assessment/site, so routing this contract there would widen a
// validator three other contracts depend on. The rules the subset cannot
// express live here, not in rules.mjs, for the reason critical-areas.mjs keeps
// its own: they belong to this contract alone.
//
// Zero dependencies, and vendorable: nothing here touches a Node global.

import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

import { auditedValidator } from './schema-problems.mjs';

const ID = 'tool-review.v1.schema.json';

const checkSchema = auditedValidator({
  [ID]: JSON.parse(readFileSync(new URL(`./${ID}`, import.meta.url), 'utf8')),
});

const listOf = (doc, key) => (Array.isArray(doc?.[key]) ? doc[key] : []);

/**
 * Validate a parsed canary.tool-review/1 report.
 * @param {unknown} doc
 * @returns {{valid: boolean, checked: number,
 *            errors: {path: string, message: string}[]}}
 *   `checked` counts the report, its ledger rows and its findings: the
 *   denominator a caller reports.
 */
export function validateToolReview(doc) {
  const errors = checkSchema(ID, doc);
  const checked =
    1 + listOf(doc, 'ledger').length + listOf(doc, 'findings').length;
  return { valid: errors.length === 0, checked, errors };
}
