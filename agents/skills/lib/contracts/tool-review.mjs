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

/** The roll-up keys D8 refuses: a composite hides the persona that was failed. */
const SCORE_KEYS = ['score', 'overall', 'composite', 'rating'];

const listOf = (doc, key) => (Array.isArray(doc?.[key]) ? doc[key] : []);
const isObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const at = (prefix, key) => (prefix ? `${prefix}.${key}` : key);

/**
 * Rule `jobOrQuality`: a finding names the job it failed, the quality it
 * failed, or both. Only an explicit null pair is refused: an absent or
 * wrong-typed field is the schema's error, not a second one here.
 */
function jobOrQuality(finding, prefix) {
  if (finding.job !== null || finding.quality !== null) return [];
  return [
    {
      path: prefix,
      message:
        'names neither a job nor a quality; set job, quality or both (rule jobOrQuality)',
    },
  ];
}

/**
 * Rule `noCompositeScore` (D8, ADR 0036): no roll-up score on the report or on
 * any finding. Key presence counts, as with rules.mjs's authorExcluded: even
 * `null` is refused, because unknown fields are otherwise tolerated and that
 * tolerance must not become a way back in for a score.
 */
function noCompositeScore(record, prefix) {
  return SCORE_KEYS.filter((key) => Object.hasOwn(record, key)).map((key) => ({
    path: at(prefix, key),
    message:
      'must not be supplied: a tool review carries no composite score (rule noCompositeScore)',
  }));
}

/**
 * Rule `evidenceRequired`: a finding cites at least one piece of evidence. The
 * subset has no `minItems`, so `evidence: []` passes the schema; a non-array is
 * the schema's error, not a second one here.
 */
function evidenceRequired(finding, prefix) {
  const { evidence } = finding;
  if (!Array.isArray(evidence) || evidence.length > 0) return [];
  return [
    {
      path: at(prefix, 'evidence'),
      message:
        'is empty; a finding cites at least one screenshot, snapshot or file (rule evidenceRequired)',
    },
  ];
}

const FINDING_RULES = [jobOrQuality, noCompositeScore, evidenceRequired];

function ruleErrors(doc) {
  if (!isObject(doc)) return [];
  return [
    ...noCompositeScore(doc, ''),
    ...listOf(doc, 'findings').flatMap((finding, i) =>
      isObject(finding)
        ? FINDING_RULES.flatMap((rule) => rule(finding, `findings[${i}]`))
        : [],
    ),
  ];
}

/**
 * Validate a parsed canary.tool-review/1 report.
 * @param {unknown} doc
 * @returns {{valid: boolean, checked: number,
 *            errors: {path: string, message: string}[]}}
 *   `checked` counts the report, its ledger rows and its findings: the
 *   denominator a caller reports.
 */
export function validateToolReview(doc) {
  const errors = [...checkSchema(ID, doc), ...ruleErrors(doc)];
  const checked =
    1 + listOf(doc, 'ledger').length + listOf(doc, 'findings').length;
  return { valid: errors.length === 0, checked, errors };
}
