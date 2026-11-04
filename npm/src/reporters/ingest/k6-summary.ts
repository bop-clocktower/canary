/**
 * k6 `handleSummary` data → a TestTracker perf report body (#1580). Sends
 * only what k6 said: the raw sub-metric key, the raw threshold expression,
 * the observed value and k6's own `ok`. Never a scenario, comparator or
 * verdict: TestTracker derives those, so a trend key has one spelling.
 */

// Same grammar TestTracker uses to parse a threshold expression on its side.
// The tests hold the two equal.
const THRESHOLD =
  /^\s*(avg|min|max|med|count|rate|value|p\(\s*\d+(?:\.\d+)?\s*\))\s*(===|==|!=|<=|>=|<|>)\s*(-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)\s*$/i;

/** The `values` key a threshold judges (`p(99)`, `rate`…), or null if it is not k6 grammar. */
export function thresholdStat(expression: string): string | null {
  const m = THRESHOLD.exec(expression);
  return m ? m[1].toLowerCase().replace(/\s+/g, '') : null;
}
