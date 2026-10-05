// signals -- pure: a timeline (plus run context) in, evidence rows out.
//
// Every row names its source and the hypotheses it bears on. A signal that
// cannot tell the hypotheses apart says so by supporting ALL of them (D8):
// nondeterminism is what a product race looks like too, so it is never
// evidence for the test alone. Nothing here ranks, scores, or counts rows per
// hypothesis -- the brief's layout is fixed (D1).

/** Fixed order. Never sort this by evidence. */
export const HYPOTHESES = ['test-defect', 'product-defect', 'environment'];

const FAILING = new Set(['failed', 'flaky']);
const isFailing = (o) => FAILING.has(o.status);

/** One evidence row. */
export function row(signal, source, detail, supports = [], weighsAgainst = []) {
  return {
    signal,
    source,
    detail,
    supports: [...supports],
    weighsAgainst: [...weighsAgainst],
  };
}

const HISTORY = 'run history';

function mixedCommits(observations) {
  const outcomes = new Map();
  for (const o of observations) {
    if (!o.commit_sha) continue;
    const seen = outcomes.get(o.commit_sha) ?? new Set();
    seen.add(isFailing(o));
    outcomes.set(o.commit_sha, seen);
  }
  return [...outcomes].filter(([, s]) => s.size === 2).map(([sha]) => sha);
}

function sameCommitMixed(observations) {
  const mixed = mixedCommits(observations);
  if (!mixed.length) return [];
  const detail =
    `passed and failed at the same commit (${mixed.join(', ')}); a ` +
    'nondeterministic outcome is consistent with every hypothesis, ' +
    'including a race in the system under test';
  return [row('same-commit-mixed', HISTORY, detail, HYPOTHESES)];
}

function retryPass(observations) {
  const flaky = observations.filter((o) => o.status === 'flaky').length;
  const retried = observations.filter(
    (o) => o.status === 'passed' && o.retry_count > 0,
  ).length;
  if (flaky + retried === 0) return [];
  const detail =
    `${flaky} observation(s) with status flaky, ${retried} pass(es) after a ` +
    'retry; a pass on retry does not say which side is nondeterministic';
  return [row('retry-pass', HISTORY, detail, HYPOTHESES)];
}

function regressionShape(observations, target) {
  if (observations.at(-1) !== target) return [];
  const passAt = observations.findLastIndex((o) => o.status === 'passed');
  if (passAt === -1) return [];
  const streak = observations.slice(passAt + 1);
  // `flaky` passed on retry, so a streak containing one is not "no pass since".
  if (!streak.every((o) => o.status === 'failed')) return [];
  const commits = new Set(streak.map((o) => o.commit_sha).filter(Boolean));
  if (streak.length < 2 || commits.size < 2) return [];
  const since = observations[passAt].commit_sha ?? 'an unrecorded commit';
  const detail =
    `passed at ${since}, then failed on ${streak.length} consecutive ` +
    `observations across ${commits.size} commits with no pass since`;
  // Not against environment: a persistent environment change (a rotated
  // credential, a moved dependency) makes the same shape.
  return [
    row('regression-shape', HISTORY, detail, ['test-defect', 'product-defect']),
  ];
}

/** Rows derived from the timeline alone. */
export function historySignals(observations, target) {
  return [
    ...sameCommitMixed(observations),
    ...retryPass(observations),
    ...regressionShape(observations, target),
  ];
}

// ---------------------------------------------------------------------------
// Failure category. RULES + categorizeFailure are COPIED from
// canary-fail-fast/scripts/failures.mjs (behaviour-for-behaviour): skills are
// self-contained and never import each other. The copy is pinned to the source
// by the parity test in agents/skills/test/canary-question.test.ts (#1140);
// change a rule there and here together, or that test goes red.
const RULES = [
  [
    'schema',
    /ZodError|invalid[_ ]type|unrecognized key|expected .+ received|at path "|\bzod\b/i,
  ],
  [
    'auth',
    /\b401\b|unauthorized|\b403\b|forbidden|invalid(?: auth)? token|token expired/i,
  ],
  ['timeout', /timeout|timed out|etimedout|deadline exceeded/i],
  [
    'network',
    /econnrefused|enotfound|econnreset|socket hang up|getaddrinfo|network request failed/i,
  ],
  [
    'server',
    /\b5\d{2}\b|internal server error|bad gateway|service unavailable|gateway timeout/i,
  ],
  [
    'client',
    /\b4(?:0[045-9]|1\d|2\d)\b|bad request|not found|unprocessable|conflict/i,
  ],
];

/** Return the category of a failure error message ('other' when unknown). */
export function categorizeFailure(error) {
  if (!error) return 'other';
  for (const [category, pattern] of RULES) {
    if (pattern.test(error)) return category;
  }
  return 'other';
}

/** The stored category, else one derived from error_text, else null. */
export function resolveCategory(obs) {
  if (obs.failure_category) {
    return {
      category: obs.failure_category,
      source: 'stored failure_category',
    };
  }
  if (obs.error_text) {
    return {
      category: categorizeFailure(obs.error_text),
      source: 'categorised from error_text',
    };
  }
  return null;
}

// Categories that name a transport-level symptom, and every hypothesis each
// symptom is consistent with. A slow or misconfigured product times out and
// rejects credentials too; a 502/503 is as often a proxy as the product. Each
// id names the observation, never a hypothesis (#1142): an id that names one
// side next to a row that supports another reads as a lean.
const CATEGORY_WEIGHTS = {
  timeout: ['category-timeout', ['environment', 'product-defect']],
  auth: ['category-auth', ['environment', 'product-defect']],
  network: ['category-network', ['environment']],
  server: ['category-server', ['product-defect', 'environment']],
};

const categoryDetail = (c) =>
  c === 'server' ? 'failure category server (5xx)' : `failure category ${c}`;

export function categoryRows(target) {
  const resolved = resolveCategory(target);
  if (!resolved) return [];
  const { category, source } = resolved;
  const weighted = CATEGORY_WEIGHTS[category];
  if (weighted) {
    const [signal, supports] = weighted;
    return [row(signal, source, categoryDetail(category), supports)];
  }
  const detail = `failure category ${category} does not discriminate between the hypotheses`;
  return [row('category-neutral', source, detail)];
}

// ---------------------------------------------------------------------------
// Co-failures: other tests that failed in the target run.

/** A category shared only as "other" is not a shared cause. */
function sharesCategory(a, b) {
  const ca = resolveCategory(a)?.category ?? null;
  const cb = resolveCategory(b)?.category ?? null;
  return ca !== null && ca !== 'other' && ca === cb;
}

const sharesArea = (a, b) => a.area != null && a.area === b.area;

/**
 * Failing alone. A narrow product regression fails alone too, so isolation is
 * evidence for both code hypotheses, and only against a shared environment.
 * A run of one test (or of an unrecorded size) cannot show isolation at all.
 */
function isolatedRows({ run_id: run, testsInRun: n }) {
  if (typeof n !== 'number') {
    const detail = `the number of tests in run ${run} is not recorded; isolation cannot be observed`;
    return [row('single-test-run', HISTORY, detail)];
  }
  if (n < 2) {
    const detail = `run ${run} contained only this test; isolation cannot be observed`;
    return [row('single-test-run', HISTORY, detail)];
  }
  const detail = `the only failing test in run ${run} (${n} tests in run)`;
  return [
    row(
      'isolated',
      HISTORY,
      detail,
      ['test-defect', 'product-defect'],
      ['environment'],
    ),
  ];
}

function unrelatedRow(target, others) {
  const detail = `${others.length} other failure(s) in run ${target.run_id}, none sharing area or category`;
  return [row('unrelated-co-failures', HISTORY, detail)];
}

export function coFailureRows(target) {
  const others = target.coFailures ?? [];
  if (!others.length) return isolatedRows(target);
  const related = others.filter(
    (o) => sharesArea(target, o) || sharesCategory(target, o),
  );
  if (!related.length) return unrelatedRow(target, others);
  const names = related
    .slice(0, 5)
    .map((o) => o.test_name)
    .join(', ');
  const detail =
    `${related.length} other failing test(s) in run ${target.run_id} share ` +
    `its category or area: ${names}; also seen when a shared test helper or ` +
    'fixture fails the same way';
  return [
    row('co-failure', HISTORY, detail, ['product-defect', 'environment']),
  ];
}

// ---------------------------------------------------------------------------
// Paths: shared by diff.mjs and findings.mjs.

function normalizePath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Equal, or one is the other with a leading directory prefix. */
export function samePath(a, b) {
  const x = normalizePath(a);
  const y = normalizePath(b);
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

const TEST_NAME = /\.(test|spec)\.|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/;
const TEST_DIR = /(^|\/)(test|tests|__tests__)\//;

export function isTestPath(p) {
  const n = normalizePath(p);
  return TEST_NAME.test(n) || TEST_DIR.test(n);
}
