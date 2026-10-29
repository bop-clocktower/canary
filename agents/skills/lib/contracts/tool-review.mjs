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

import { TIMESTAMP_RE, isTimestamp } from './field-checks.mjs';
import { isPlainObject } from './schema-check.mjs';
import { auditedValidator } from './schema-problems.mjs';

const ID = 'tool-review.v1.schema.json';

const checkSchema = auditedValidator({
  [ID]: JSON.parse(readFileSync(new URL(`./${ID}`, import.meta.url), 'utf8')),
});

/** The roll-up keys D8 refuses: a composite hides the persona that was failed. */
const SCORE_KEYS = ['score', 'overall', 'composite', 'rating'];

const listOf = (doc, key) => (Array.isArray(doc?.[key]) ? doc[key] : []);
// A copy of rules.mjs's `at`, which that module does not export.
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

const EVIDENCE_KINDS = ['screenshot', 'snapshot', 'file'];

/** Per state, the evidence kinds of which a row cites at least one. */
const EVIDENCE_COMPANION = {
  walked: [
    ['snapshot', 'screenshot'],
    'cites no snapshot or screenshot; a walked row was driven live in the browser',
  ],
  mapped: [
    ['file'],
    'cites no file; a mapped row is judged from code and docs',
  ],
};

/** Per state, why a row whose reason is null is refused. */
const REASON_COMPANION = {
  'not-assessed': 'is null; a not-assessed row says why it was not examined',
  'not-applicable':
    "is null; a not-applicable row carries the overlay's reason",
};

/**
 * Rule `ledgerCompanion`: each state carries the companion the spec's ledger
 * table requires. A walked row cites live evidence, not only a file; a mapped
 * row cites a file; a not-assessed or not-applicable row has a reason. Malformed
 * evidence, a blank reason or an unknown state is the schema's error, not a
 * second one here.
 */
function ledgerCompanion(row, prefix) {
  const { state, reason, evidence } = row;
  if (Object.hasOwn(REASON_COMPANION, state)) {
    if (reason !== null) return [];
    const message = `${REASON_COMPANION[state]} (rule ledgerCompanion)`;
    return [{ path: at(prefix, 'reason'), message }];
  }
  if (!Object.hasOwn(EVIDENCE_COMPANION, state)) return [];
  const wellFormed = (e) =>
    isPlainObject(e) &&
    EVIDENCE_KINDS.includes(e.kind) &&
    typeof e.ref === 'string';
  if (!Array.isArray(evidence) || !evidence.every(wellFormed)) return [];
  const [kinds, why] = EVIDENCE_COMPANION[state];
  if (evidence.some((e) => kinds.includes(e.kind))) return [];
  const message = `${why} (rule ledgerCompanion)`;
  return [{ path: at(prefix, 'evidence'), message }];
}

/**
 * Rule `real-dates` on `reviewed_at`, the check every canary contract with a
 * timestamp shares (#1225): the pattern admits month 13 and 2025-02-29, and
 * phase 3 orders reviews by this field. A string the pattern refuses, or a
 * non-string, is the schema's error, not a second one here.
 */
function realReviewedAt(doc) {
  const value = doc.reviewed_at;
  if (typeof value !== 'string' || !TIMESTAMP_RE.test(value)) return [];
  if (isTimestamp(value)) return [];
  return [
    {
      path: 'reviewed_at',
      message: `${JSON.stringify(value)} matches the timestamp pattern but is not a real date`,
    },
  ];
}

/**
 * Rule `idsUnique`: within `ledger`, and within `findings`, no two records
 * share an `id`. Phase 3's diff and `file --pick` select findings by id. Each
 * repeat is refused at its own path; the first is the one it names. The two
 * lists are separate namespaces. A missing, non-string or blank id is the
 * schema's error, not a second one here.
 */
function idsUnique(doc, key) {
  const first = new Map();
  return listOf(doc, key).flatMap((record, i) => {
    const id = isPlainObject(record) ? record.id : undefined;
    if (typeof id !== 'string' || id.trim() === '') return [];
    if (!first.has(id)) {
      first.set(id, i);
      return [];
    }
    const message = `duplicates ${key}[${first.get(id)}].id ${JSON.stringify(id)}; ids are unique within ${key} (rule idsUnique)`;
    return [{ path: `${key}[${i}].id`, message }];
  });
}

const FINDING_RULES = [jobOrQuality, noCompositeScore, evidenceRequired];

function ruleErrors(doc) {
  if (!isPlainObject(doc)) return [];
  return [
    ...realReviewedAt(doc),
    ...noCompositeScore(doc, ''),
    ...listOf(doc, 'ledger').flatMap((row, i) =>
      isPlainObject(row) ? ledgerCompanion(row, `ledger[${i}]`) : [],
    ),
    ...idsUnique(doc, 'ledger'),
    ...listOf(doc, 'findings').flatMap((finding, i) =>
      isPlainObject(finding)
        ? FINDING_RULES.flatMap((rule) => rule(finding, `findings[${i}]`))
        : [],
    ),
    ...idsUnique(doc, 'findings'),
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
