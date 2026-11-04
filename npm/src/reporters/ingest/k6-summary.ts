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
export function thresholdStat(expression: string): string | null {
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
