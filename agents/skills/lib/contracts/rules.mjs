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
const RESULT_COUNT_KEYS = ['duration_ms', 'retries'];
const ASSESSED = ['healthy', 'degraded', 'critical', 'observed'];
const AUTHOR_KEYS = ['who', 'author'];

function at(prefix, field) {
  return prefix ? `${prefix}.${field}` : field;
}

function isAbsent(v) {
  return v === null || v === undefined;
}

/**
 * Rule `counts-safe`: every `count` is a safe integer. Above 2^53 - 1 a JSON number is not
 * the integer the producer wrote, and the totals sum compares lossily (the
 * keyword subset has no `maximum`, deliberately). The arithmetic rules below
 * skip unsafe counts so this is the one error reported for them.
 */
function unsafeCounts(record, keys, prefix) {
  if (!isPlainObject(record)) return [];
  return keys
    .filter((k) => Number.isInteger(record[k]))
    .filter((k) => !Number.isSafeInteger(record[k]))
    .map((k) => ({
      path: at(prefix, k),
      message: `must be a safe integer (at most ${Number.MAX_SAFE_INTEGER})`,
    }));
}

function countsSafe(run, prefix) {
  const results = Array.isArray(run.results) ? run.results : [];
  return [
    ...unsafeCounts(run.totals, [...COUNT_KEYS, 'total'], at(prefix, 'totals')),
    ...results.flatMap((r, i) =>
      unsafeCounts(r, RESULT_COUNT_KEYS, at(prefix, `results[${i}]`)),
    ),
  ];
}

/** Criterion 4: totals.total === results.length, when results are carried. */
function totalsMatchResults(run, prefix) {
  const total = isPlainObject(run.totals) ? run.totals.total : undefined;
  if (!Array.isArray(run.results) || !Number.isSafeInteger(total)) return [];
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
  if (!isPlainObject(t) || !Number.isSafeInteger(t.total)) return [];
  const counts = COUNT_KEYS.map((k) => t[k]);
  if (!counts.every(Number.isSafeInteger)) return [];
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

const TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;
/** Hour, minute, second, offset hour, offset minute. A leap second is refused. */
const CLOCK_MAX = [23, 59, 59, 23, 59];

/** setUTCFullYear, not Date.UTC: Date.UTC reads years 0-99 as 1900-1999. */
const daysInMonth = (year, month) =>
  new Date(new Date(0).setUTCFullYear(year, month, 0)).getUTCDate();

const isRealDay = (y, mo, d) =>
  mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);

/**
 * Range-checks the timestamp's own fields; `Date.parse` rolls 02-30 over to
 * 03-02 (#1154 S2). A string the pattern refuses is the schema's error.
 */
function isRealInstant(value) {
  const m = TIMESTAMP_RE.exec(value);
  if (m === null) return true;
  const [y, mo, d, ...clock] = m.slice(1).map((g) => Number(g ?? 0));
  return isRealDay(y, mo, d) && clock.every((v, i) => v <= CLOCK_MAX[i]);
}

/**
 * Rule `real-dates`: a timestamp names an instant. The pattern admits month 13
 * or February 30, which a reader sorts or dates wrongly (#1151 phase 3 review,
 * #1154 S2). Only strings are checked; a non-string is the schema's error.
 */
const realDates =
  (...paths) =>
  (record, prefix) =>
    paths.flatMap((path) => {
      const value = path.reduce(
        (o, key) => (isPlainObject(o) ? o[key] : undefined),
        record,
      );
      if (typeof value !== 'string' || isRealInstant(value)) return [];
      return [
        {
          path: at(prefix, path.join('.')),
          message: `${JSON.stringify(value)} matches the timestamp pattern but is not a real date`,
        },
      ];
    });

const RUN_RULES = [
  countsSafe,
  totalsMatchResults,
  totalsSum,
  realDates(['run', 'started_at'], ['run', 'finished_at']),
];
const ASSESSMENT_RULES = [
  verifiedSupplied,
  verificationPair,
  statusShape,
  realDates(['observed_at'], ['verified_at']),
];
const REGISTER_RULES = [authorExcluded, realDates(['recorded_at'])];

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
    ...applyRules([realDates(['generated_at'])], doc, ''),
    ...nested(doc, 'runs', RUN_RULES),
    ...nested(doc, 'assessments', ASSESSMENT_RULES),
    ...nested(doc, 'register', REGISTER_RULES),
  ];
}
