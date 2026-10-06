// assess -- canary ci-ready checks as canary.assessment/1 records (P1).
//
// Starling owns no metric math: the number is the check's own `measure`.
// A check without one measured nothing, so it is `not-assessed` with the
// check's own reason -- whatever its verdict says (a thin window warns, a
// structural zero passes; neither is a measurement). Every metric is
// emitted, present or not: an absent input is never an omitted row (crit 8).

export const CI_READY_METRICS = [
  'coverage-depth',
  'flakiness',
  'assertion-quality',
  'critical-paths',
  'suite-runtime',
];
const SOURCE = 'canary.ci-ready';
const STATUS = { pass: 'healthy', warn: 'degraded', fail: 'critical' };

function base(scope, metric, observedAt, sources) {
  return {
    contract: 'canary.assessment/1',
    scope,
    source: SOURCE,
    metric,
    observed_at: observedAt,
    sources,
    verified_by: null,
    verified_at: null,
  };
}

function abstain(scope, metric, observedAt, sources, reason) {
  return {
    ...base(scope, metric, observedAt, sources),
    status: 'not-assessed',
    value: null,
    unit: null,
    reason,
    evidence: { tier: null, denominator: null },
  };
}

function fromCheck(c, scope, observedAt, sources) {
  if (!c.measure || !STATUS[c.verdict])
    return abstain(scope, c.name, observedAt, sources, c.reason);
  return {
    ...base(scope, c.name, observedAt, sources),
    status: STATUS[c.verdict],
    value: c.measure.value,
    unit: c.measure.unit,
    reason: null,
    evidence: { tier: null, denominator: c.measure.denominator },
  };
}

const NO_REPORT = 'no ci-ready report supplied (run `canary ci-ready --json`)';

const isInstant = (v) =>
  typeof v === 'string' && Number.isFinite(Date.parse(v));

/** Every metric as an abstention: the report was absent or cannot be dated. */
function allAbsent(scope, now, source, note) {
  const sources = source ? [source] : [];
  const reason = note
    ? `the ci-ready report ${source} has no observed_at, so its checks are treated as absent`
    : NO_REPORT;
  return {
    real: [],
    synthetic: CI_READY_METRICS.map((m) =>
      abstain(scope, m, now, sources, reason),
    ),
    note,
  };
}

/**
 * `real` is what a dated report's checks said; `synthetic` is the abstention
 * starling generates for a metric nothing measured (no report, an undated
 * report, a metric the report lacks). Synthetic rows only fill keys no real
 * record holds (withAbstentions), so "now, not assessed" never buries a real,
 * older measurement. `note` names an undated report for stderr.
 * @param report parsed `canary ci-ready --json`, or null when none was supplied
 * @param opts {now: ISO string, source: the report's path or null}
 */
export function ciReadyAssessments(report, scope, { now, source }) {
  if (!report) return allAbsent(scope, now, source, null);
  const observedAt = report.observed_at;
  if (!isInstant(observedAt))
    return allAbsent(
      scope,
      now,
      source,
      `ci-ready report ${source} has no observed_at; treated as absent, its metrics not-assessed`,
    );
  const sources = source ? [source] : [];
  const checks = Array.isArray(report.checks) ? report.checks : [];
  const named = (m) => checks.some((c) => c.name === m);
  return {
    real: checks
      .filter((c) => CI_READY_METRICS.includes(c.name))
      .map((c) => fromCheck(c, scope, observedAt, sources)),
    synthetic: CI_READY_METRICS.filter((m) => !named(m)).map((m) =>
      abstain(
        scope,
        m,
        observedAt,
        sources,
        `the ci-ready report has no ${m} check`,
      ),
    ),
    note: null,
  };
}

const assessmentKey = (a) =>
  [a.scope.id, a.scope.env, a.source, a.metric].join('\u0000');

/** `real`, plus each synthetic abstention whose key no real record holds (D4). */
export function withAbstentions(real, synthetic) {
  const held = new Set(real.map(assessmentKey));
  return [...real, ...synthetic.filter((a) => !held.has(assessmentKey(a)))];
}

/** Consumers read "latest per key" (spec, assessment layer); the feed ships only that. */
export function latestPerKey(assessments) {
  const latest = new Map();
  for (const a of assessments) {
    const k = assessmentKey(a);
    const prior = latest.get(k);
    if (!prior || Date.parse(a.observed_at) >= Date.parse(prior.observed_at))
      latest.set(k, a);
  }
  return [...latest.values()];
}
