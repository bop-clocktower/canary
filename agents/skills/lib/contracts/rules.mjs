// Cross-field rules of the canary QA contracts (#1151, ADR 0035).
//
// The JSON Schemas state shape. These are the relations BETWEEN fields that
// the supported keyword subset cannot express without if/then/not, which
// schema-check.mjs deliberately does not implement. Each rule is named in
// docs/specs/ so a refused producer can find out why. Every rule is
// defensive: a field of the wrong type is the schema's error to report, not
// a second error here.

import { isPlainObject } from './schema-check.mjs';

const COUNT_KEYS = [
  'passed',
  'failed',
  'flaky',
  'skipped',
  'timed_out',
  'interrupted',
];
const ASSESSED = ['healthy', 'degraded', 'critical', 'observed'];
const AUTHOR_KEYS = ['who', 'author'];

function at(prefix, field) {
  return prefix ? `${prefix}.${field}` : field;
}

function isAbsent(v) {
  return v === null || v === undefined;
}

/** Criterion 4: totals.total === results.length, when results are carried. */
function totalsMatchResults(run, prefix) {
  const total = isPlainObject(run.totals) ? run.totals.total : undefined;
  if (!Array.isArray(run.results) || !Number.isInteger(total)) return [];
  if (total === run.results.length) return [];
  const n = run.results.length;
  return [
    {
      path: at(prefix, 'totals.total'),
      message: `is ${total} but results has ${n} entr${n === 1 ? 'y' : 'ies'}`,
    },
  ];
}

/** Fork K: the per-status counts add up to totals.total. */
function totalsSum(run, prefix) {
  const t = run.totals;
  if (!isPlainObject(t) || !Number.isInteger(t.total)) return [];
  const counts = COUNT_KEYS.map((k) => t[k]);
  if (!counts.every(Number.isInteger)) return [];
  const sum = counts.reduce((a, b) => a + b, 0);
  if (sum === t.total) return [];
  return [
    {
      path: at(prefix, 'totals.total'),
      message: `is ${t.total} but the per-status counts sum to ${sum}`,
    },
  ];
}

/** Criterion 3 / D5: `verified` is derived; supplying it, even null, is refused. */
function verifiedSupplied(a, prefix) {
  if (!Object.hasOwn(a, 'verified')) return [];
  return [
    {
      path: at(prefix, 'verified'),
      message:
        'is derived from verified_by + verified_at and must not be supplied (D5)',
    },
  ];
}

/** Criterion 17 / D5: verified_by and verified_at are both set or both null. */
function verificationPair(a, prefix) {
  const byMissing = isAbsent(a.verified_by);
  if (byMissing === isAbsent(a.verified_at)) return [];
  const [missing, present] = byMissing
    ? ['verified_by', 'verified_at']
    : ['verified_at', 'verified_by'];
  return [
    {
      path: at(prefix, missing),
      message: `must be set when ${present} is set: both or neither (D5)`,
    },
  ];
}

/** Criterion 2 / D4: not-assessed has no value and a non-blank reason. */
function abstainedShape(a, prefix) {
  const errors = [];
  if (!isAbsent(a.value)) {
    errors.push({
      path: at(prefix, 'value'),
      message: 'must be null when status is not-assessed (D4)',
    });
  }
  if (typeof a.reason !== 'string' || a.reason.trim() === '') {
    errors.push({
      path: at(prefix, 'reason'),
      message: 'is required when status is not-assessed (D4)',
    });
  }
  return errors;
}

/** Fork D: every other status has a value and no reason (both "iff"s). */
function assessedShape(a, prefix) {
  const errors = [];
  if (a.value === null) {
    errors.push({
      path: at(prefix, 'value'),
      message: `must not be null when status is ${a.status}; abstain with not-assessed and a reason (D4)`,
    });
  }
  if (!isAbsent(a.reason)) {
    errors.push({
      path: at(prefix, 'reason'),
      message: `must be null when status is ${a.status}; a reason is required only for not-assessed (D4)`,
    });
  }
  return errors;
}

function statusShape(a, prefix) {
  if (a.status === 'not-assessed') return abstainedShape(a, prefix);
  if (ASSESSED.includes(a.status)) return assessedShape(a, prefix);
  return [];
}

/**
 * Fork C (amended): a register row carries no author identity. Unknown fields
 * are otherwise tolerated (D3), so without this rule a producer could leak a
 * name or email into a public feed through that tolerance. Key presence
 * counts, as with `verified`: even `null` is refused.
 */
function authorExcluded(row, prefix) {
  return AUTHOR_KEYS.filter((key) => Object.hasOwn(row, key)).map((key) => ({
    path: at(prefix, key),
    message:
      'must not be supplied: author identity is deliberately excluded from a public feed',
  }));
}

const RUN_RULES = [totalsMatchResults, totalsSum];
const ASSESSMENT_RULES = [verifiedSupplied, verificationPair, statusShape];
const REGISTER_RULES = [authorExcluded];

function applyRules(rules, record, prefix) {
  if (!isPlainObject(record)) return [];
  return rules.flatMap((rule) => rule(record, prefix));
}

function nested(site, key, rules) {
  if (!Array.isArray(site[key])) return [];
  return site[key].flatMap((r, i) => applyRules(rules, r, `${key}[${i}]`));
}

/** Every cross-field violation in a document of the given layer. */
export function crossFieldErrors(layer, doc) {
  if (layer === 'run') return applyRules(RUN_RULES, doc, '');
  if (layer === 'assessment') return applyRules(ASSESSMENT_RULES, doc, '');
  return [
    ...nested(doc, 'runs', RUN_RULES),
    ...nested(doc, 'assessments', ASSESSMENT_RULES),
    ...nested(doc, 'register', REGISTER_RULES),
  ];
}
