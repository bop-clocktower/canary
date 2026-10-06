// flaky -- distinct flaky tests over each suite's window (D13).
//
// The feed keeps per-test results on one run per suite, so a page cannot
// count distinct flakes; this does, over the selected window. A count-only
// run (results null) is outside the denominator: it cannot say which test
// flaked.

const key = (...parts) => parts.join('\u0000');

export function flakyTests(window) {
  const windowRuns = new Map();
  const hits = new Map();
  for (const r of window) {
    if (!Array.isArray(r.results)) continue;
    const suite = key(r.scope.id, r.scope.env, r.run.suite);
    windowRuns.set(suite, (windowRuns.get(suite) ?? 0) + 1);
    for (const t of r.results) {
      if (t.status !== 'flaky') continue;
      const k = key(suite, t.file, t.title);
      const prior = hits.get(k);
      hits.set(
        k,
        prior
          ? { ...prior, flaky_runs: prior.flaky_runs + 1 }
          : {
              scope: r.scope,
              suite: r.run.suite,
              title: t.title,
              file: t.file,
              flaky_runs: 1,
              suiteKey: suite,
            },
      );
    }
  }
  return [...hits.values()].map(({ suiteKey, ...row }) => ({
    ...row,
    window_runs: windowRuns.get(suiteKey),
  }));
}
