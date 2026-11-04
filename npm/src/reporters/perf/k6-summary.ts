/**
 * k6 `handleSummary` data → a TestTracker perf report body (#1580). Sends
 * only what k6 said: the raw sub-metric key, the raw threshold expression,
 * the observed value and k6's own `ok`. Never a scenario, comparator or
 * verdict: TestTracker derives those, so a trend key has one spelling.
 */
import { readFileSync, statSync } from 'node:fs';

// Same grammar TestTracker uses to parse a threshold expression on its side.
// The tests hold the two equal.
const THRESHOLD =
  /^\s*(avg|min|max|med|count|rate|value|p\(\s*\d+(?:\.\d+)?\s*\))\s*(===|==|!=|<=|>=|<|>)\s*(-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)\s*$/i;

/** The `values` key a threshold judges (`p(99)`, `rate`…), or null if it is not k6 grammar. */
function thresholdStat(expression: string): string | null {
  const m = THRESHOLD.exec(expression);
  return m ? m[1].toLowerCase().replace(/\s+/g, '') : null;
}

export interface K6Metric {
  type?: string;
  values: Record<string, unknown>;
  thresholds?: Record<string, { ok: boolean }>;
}
export interface K6Summary {
  metrics: Record<string, K6Metric>;
  state?: { testRunDurationMs?: unknown };
}

/** The file cannot be read as handleSummary data; the command exits 1. */
export class K6SummaryError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Reads k6 `handleSummary` data (`JSON.stringify(data)`), never the older
 * `--summary-export` format, whose thresholds are bare booleans and would
 * otherwise be misread as "no thresholds".
 */
export function readK6Summary(file: string): { summary: K6Summary; mtime: Date } {
  let text: string;
  let mtime: Date;
  try {
    text = readFileSync(file, 'utf8');
    mtime = statSync(file).mtime;
  } catch (e) {
    throw new K6SummaryError(`cannot read ${file}: ${(e as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new K6SummaryError(`${file} is not JSON.`);
  }
  if (!isObject(data) || !isObject(data.metrics)) {
    throw new K6SummaryError(`${file} is not k6 handleSummary data (no "metrics" object).`);
  }
  for (const [name, m] of Object.entries(data.metrics)) {
    if (!isObject(m) || !isObject(m.values)) {
      throw new K6SummaryError(
        `${file}: metric "${name}" has no "values" object. This looks like --summary-export output; ` +
          'push-perf reads handleSummary data (return JSON.stringify(data) from handleSummary).',
      );
    }
    if (m.thresholds === undefined) continue;
    if (!isObject(m.thresholds)) throw new K6SummaryError(`${file}: "${name}".thresholds is not an object.`);
    for (const [expr, t] of Object.entries(m.thresholds)) {
      if (!isObject(t) || typeof t.ok !== 'boolean') {
        throw new K6SummaryError(`${file}: threshold "${expr}" on "${name}" has no boolean "ok".`);
      }
    }
  }
  return { summary: data as unknown as K6Summary, mtime };
}

export interface PerfObjective {
  submetric: string;
  expression: string;
  observedValue: number | null;
  ok: boolean;
}

const finiteOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * Whether k6 collected any sample for this metric. k6 reports an unsampled
 * metric as zeros and judges its thresholds ok, so a route that never ran
 * would otherwise read as met:
 *
 * - a Rate with no samples reports `rate: 0`, and `passes + fails === 0`
 *   says so directly;
 * - a Trend with no samples reports 0 for every `summaryTrendStats` key and
 *   carries no sample count (measured on k6 v2.2.0). `min === 0 && max === 0`
 *   is the signal: no real request completes in 0 ms over HTTP, so a Trend
 *   whose every sample was exactly 0 is treated as unmeasured too.
 */
function sampled(m: K6Metric): boolean {
  if (m.type === 'rate') {
    return (finiteOrNull(m.values.passes) ?? 0) + (finiteOrNull(m.values.fails) ?? 0) > 0;
  }
  if (m.type === 'trend') return !(m.values.min === 0 && m.values.max === 0);
  return true;
}

/**
 * One objective per `metrics[m].thresholds[expr]`. `observedValue` is
 * `values[stat]`, or null when k6 measured nothing for it: TestTracker stores
 * that as unmeasured, never met. A percentile threshold is only reported when
 * its percentile is in `options.summaryTrendStats`. Sorted by sub-metric, then
 * expression, so `--dry-run` output is diffable across runs.
 */
export function k6Objectives(summary: K6Summary): PerfObjective[] {
  const out: PerfObjective[] = [];
  for (const submetric of Object.keys(summary.metrics).sort()) {
    const m = summary.metrics[submetric];
    const thresholds = m.thresholds ?? {};
    for (const expression of Object.keys(thresholds).sort()) {
      const stat = thresholdStat(expression);
      const observedValue = stat !== null && sampled(m) ? finiteOrNull(m.values[stat]) : null;
      out.push({ submetric, expression, observedValue, ok: thresholds[expression].ok });
    }
  }
  return out;
}

/** The run's headline measurements. Each is null when k6 did not report it. */
export interface PerfHeadline {
  httpReqs: number | null;
  httpReqRate: number | null;
  iterations: number | null;
  durationMs: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

export function k6Headline(summary: K6Summary): PerfHeadline {
  const v = (metric: string, key: string) => finiteOrNull(summary.metrics[metric]?.values[key]);
  const int = (n: number | null) => (n === null ? null : Math.round(n));
  return {
    httpReqs: int(v('http_reqs', 'count')),
    httpReqRate: v('http_reqs', 'rate'),
    iterations: int(v('iterations', 'count')),
    durationMs: int(finiteOrNull(summary.state?.testRunDurationMs)),
    p95Ms: v('http_req_duration', 'p(95)'),
    p99Ms: v('http_req_duration', 'p(99)'),
  };
}

/**
 * Why this run must not be pushed, or null. A run that measured nothing
 * would read as a smaller, greener history. Null counts as 0, matching the
 * server's own 422 for the same case, which stays only a backstop.
 */
export function k6Abstention(summary: K6Summary, headline: PerfHeadline): string | null {
  if (Object.keys(summary.metrics).length === 0) return 'the summary holds no metrics';
  if ((headline.httpReqs ?? 0) === 0 && (headline.iterations ?? 0) === 0) {
    return 'the run made 0 requests and 0 iterations';
  }
  return null;
}

/** What was read, stated every run: a push is only as good as its denominator. */
export function k6Denominator(file: string, objectives: readonly PerfObjective[]): string {
  const measured = objectives.filter((o) => o.observedValue !== null);
  const ok = measured.filter((o) => o.ok).length;
  const unmeasured = objectives.length - measured.length;
  const subs = new Set(objectives.map((o) => o.submetric)).size;
  let s =
    `canary testtracker: read ${objectives.length} thresholds on ${subs} sub-metrics from ${file}: ` +
    `${ok} ok, ${measured.length - ok} not ok, ${unmeasured} unmeasured.\n`;
  if (objectives.length === 0) {
    s += 'canary testtracker: no thresholds, so TestTracker stores this run as measured, unjudged, never a pass.\n';
  }
  if (unmeasured > 0) {
    s +=
      `canary testtracker: ${unmeasured} unmeasured: k6 reported no value for their statistic, ` +
      'or collected no samples for the metric (a tag that matched no request). ' +
      "A percentile threshold needs that percentile in options.summaryTrendStats (e.g. 'p(99)').\n";
  }
  return s;
}
