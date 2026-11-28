// evidence -- the three dimensions read from evidence other tools record about
// the team's work: defects that escaped, how changed code was judged, and
// whether closed issues' fixes ever ran (spec "Per-dimension rules").
//
// Each is a ratio, and each was admitted because its denominator cannot be
// padded by adding green tests (spec D4):
//
//   escaped-defects          escapes / (escapes + caught), hand-kept defect log
//   coverage-verified-share  units a coverage report spoke to / changed units
//   closure-exercise         exercised / (exercised + not-exercised), batwoman
//
// An evaluator returns `{value, basis, detail}` or `{reason}`; `evaluate` in
// dimension.mjs turns that into a dimension. Every string returned here may
// carry input text and is escaped by the renderer, never here.

import { isRecord, plural } from './dimension.mjs';
import { overEntries } from './read.mjs';

/** `YYYY-MM-DD`, optionally with a time (manhunter's escapes.ts rule). */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/;

function escapeLogProblem(log) {
  if (!isRecord(log)) return 'the escape log top level is not an object';
  const since = log.tracked_since;
  if (typeof since !== 'string' || !ISO_DATE.test(since)) {
    return (
      'the escape log needs a tracked_since ISO date (YYYY-MM-DD): without ' +
      'it, "none escaped" and "nobody counted" look the same'
    );
  }
  if (!Array.isArray(log.escapes) || !Array.isArray(log.caught)) {
    return (
      'the escape log needs an escapes array and a caught array: without the ' +
      'defects caught before release the ratio has no denominator'
    );
  }
  return null;
}

/**
 * escaped-defects: `.canary/escapes.json` plus its `caught` list.
 *
 * @param {any} log
 * @param {{limits: import('./read.mjs').Limits}} opts
 * @returns {import('./dimension.mjs').Evaluation}
 */
export function escapedDefects(log, { limits }) {
  const problem = escapeLogProblem(log);
  if (problem) return { reason: problem };
  const escaped = log.escapes.length;
  const caught = log.caught.length;
  const total = escaped + caught;
  const over = overEntries(total, limits);
  if (over) return { reason: over };
  const since = log.tracked_since;
  if (total === 0) {
    return { reason: `0 defects recorded since ${since}, escaped or caught` };
  }
  return {
    value: escaped / total,
    basis: `${escaped} of ${total} defects recorded since ${since} escaped`,
    detail: { escaped, caught },
  };
}

const GUARDIAN_SOURCE = 'canary-pr-guardian';

function unitsOf(coverage) {
  if (!isRecord(coverage)) return { why: 'no_coverage' };
  const { unitsMatched: matched, unitsTotal: total } = coverage;
  const valid =
    Number.isInteger(matched) &&
    Number.isInteger(total) &&
    matched >= 0 &&
    total > 0 &&
    matched <= total;
  return valid ? { matched, total } : { why: 'no_coverage' };
}

/** Why a guardian record file is not counted, or the units it contributes. */
function classifyRecord(read) {
  if (read.kind !== 'ok') return { why: 'unreadable' };
  const r = read.value;
  const recognised =
    isRecord(r) &&
    r.source === GUARDIAN_SOURCE &&
    typeof r.schemaVersion === 'string';
  if (!recognised) return { why: 'not_guardian' };
  const judged = r.abstained !== true && Number.isInteger(r.checked);
  if (!judged || r.checked <= 0) return { why: 'judged_nothing' };
  return unitsOf(r.coverage);
}

function tallyRecords(files) {
  const t = { records: 0, unitsMatched: 0, unitsTotal: 0 };
  const notCounted = {
    unreadable: 0,
    not_guardian: 0,
    judged_nothing: 0,
    no_coverage: 0,
  };
  for (const { read } of files) {
    const c = classifyRecord(read);
    if (c.why) {
      notCounted[c.why] += 1;
      continue;
    }
    t.records += 1;
    t.unitsMatched += c.matched;
    t.unitsTotal += c.total;
  }
  return { ...t, not_counted: notCounted };
}

/**
 * coverage-verified-share: guardian analysis records (`.harness/analyses`).
 * The directory read already bounded the record count, so no option is used.
 *
 * @param {Array<{name: string, read: any}>} files
 * @param {object} [_opts] every evaluator takes the same arguments
 * @returns {import('./dimension.mjs').Evaluation}
 */
export function coverageShare(files, _opts) {
  if (files.length === 0) {
    return { reason: `no ${GUARDIAN_SOURCE}-*.json records` };
  }
  const t = tallyRecords(files);
  if (t.records === 0) {
    const n = t.not_counted;
    return {
      reason:
        `${plural(files.length, 'guardian record')} read, none counted: ` +
        `${n.unreadable} unreadable, ${n.not_guardian} not a guardian record, ` +
        `${n.judged_nothing} judged nothing, ${n.no_coverage} without a ` +
        'coverage block',
      detail: t,
    };
  }
  return {
    value: t.unitsMatched / t.unitsTotal,
    basis:
      `${t.unitsMatched} of ${t.unitsTotal} changed units across ` +
      `${plural(t.records, 'guardian record')} were judged with a coverage report`,
    detail: t,
  };
}

/** batwoman's five statuses (ts/src/analysis/batwoman/verdict.ts). */
const STATUSES = [
  'exercised',
  'not-exercised',
  'abstain',
  'no-probe',
  'not-applicable',
];

const isClosure = (r) =>
  isRecord(r) && Number.isInteger(r.issue) && Array.isArray(r.files);

function countStatus(t, file) {
  const status = isRecord(file) ? file.status : null;
  if (STATUSES.includes(status)) t[status] += 1;
  else t.unrecognised += 1;
}

function emptyClosureTally() {
  const t = { closures: 0 };
  for (const s of STATUSES) t[s] = 0;
  return { ...t, unrecognised: 0, duplicates: 0, malformed: 0 };
}

/**
 * One report per issue (spec D11): the first by sorted file name counts and
 * the rest are duplicates, so re-running batwoman on a good closure cannot pad
 * the share.
 */
function tallyClosures(files, limits) {
  const t = emptyClosureTally();
  const seen = new Set();
  let entries = 0;
  for (const { read } of files) {
    const report = read.kind === 'ok' ? read.value : null;
    if (!isClosure(report)) {
      t.malformed += 1;
      continue;
    }
    if (seen.has(report.issue)) {
      t.duplicates += 1;
      continue;
    }
    seen.add(report.issue);
    entries += report.files.length;
    const over = overEntries(entries, limits);
    if (over) return { reason: over };
    t.closures += 1;
    for (const file of report.files) countStatus(t, file);
  }
  return t;
}

/**
 * closure-exercise: batwoman `--json` reports.
 *
 * @param {Array<{name: string, read: any}>} files
 * @param {{limits: import('./read.mjs').Limits}} opts
 * @returns {import('./dimension.mjs').Evaluation}
 */
export function closureExercise(files, { limits }) {
  if (files.length === 0) return { reason: 'no batwoman reports' };
  const t = tallyClosures(files, limits);
  if (t.reason) return { reason: t.reason };
  const claims = t.exercised + t['not-exercised'];
  const across = plural(t.closures, 'closure');
  const others =
    `${t.abstain} abstain, ${t['no-probe']} no-probe, ` +
    `${t['not-applicable']} not-applicable`;
  if (claims === 0) {
    return {
      reason: `no changed file made a claim across ${across}: ${others}`,
      detail: t,
    };
  }
  return {
    value: t.exercised / claims,
    basis:
      `${t.exercised} of ${claims} changed files with a claim had run since ` +
      `their fix merged, across ${across}; ${others}`,
    detail: t,
  };
}
