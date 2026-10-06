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

/**
 * @param report parsed `canary ci-ready --json`, or null when none was supplied
 * @param opts {now: ISO string, source: the report's path or null}
 */
export function ciReadyAssessments(report, scope, { now, source }) {
  if (!report)
    return CI_READY_METRICS.map((m) =>
      abstain(
        scope,
        m,
        now,
        [],
        'no ci-ready report supplied (run `canary ci-ready --json`)',
      ),
    );
  const observedAt = report.observed_at ?? now;
  const sources = source ? [source] : [];
  const checks = Array.isArray(report.checks) ? report.checks : [];
  const out = checks
    .filter((c) => CI_READY_METRICS.includes(c.name))
    .map((c) => fromCheck(c, scope, observedAt, sources));
  for (const m of CI_READY_METRICS) {
    if (!checks.some((c) => c.name === m))
      out.push(
        abstain(
          scope,
          m,
          observedAt,
          sources,
          `the ci-ready report has no ${m} check`,
        ),
      );
  }
  return out;
}
