// flaky -- distinct flaky tests over each suite's window (D13).
//
// The feed keeps per-test results on one run per suite, so a page cannot
// count distinct flakes; this does, over the selected window. A count-only
// run (results null) is outside the denominator: it cannot say which test
// flaked. Runs are LOGICAL runs: the shards of one run are one run, and a test
// that flaked on two of them flaked in one run.

import { logicalId } from './runs.mjs';

const key = (...parts) => parts.join('\u0000');

function addTo(sets, k, value) {
  const set = sets.get(k) ?? new Set();
  sets.set(k, set.add(value));
}

export function flakyTests(window) {
  const windowRuns = new Map();
  const hits = new Map();
  const flakedIn = new Map();
  for (const r of window) {
    if (!Array.isArray(r.results)) continue;
    const suite = key(r.scope.id, r.scope.env, r.run.suite);
    const run = logicalId(r);
    addTo(windowRuns, suite, run);
    for (const t of r.results.filter((x) => x.status === 'flaky')) {
      const k = key(suite, t.file, t.title);
      if (!hits.has(k))
        hits.set(k, {
          row: { scope: r.scope, suite: r.run.suite, title: t.title },
          file: t.file,
          suite,
        });
      addTo(flakedIn, k, run);
    }
  }
  return [...hits].map(([k, { row, file, suite }]) => ({
    ...row,
    file,
    flaky_runs: flakedIn.get(k).size,
    window_runs: windowRuns.get(suite).size,
  }));
}
