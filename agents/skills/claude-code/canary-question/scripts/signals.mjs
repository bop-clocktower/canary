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
  const commits = new Set(streak.map((o) => o.commit_sha).filter(Boolean));
  if (streak.length < 2 || commits.size < 2) return [];
  const since = observations[passAt].commit_sha ?? 'an unrecorded commit';
  const detail =
    `passed at ${since}, then failed on ${streak.length} consecutive ` +
    `observations across ${commits.size} commits with no pass since`;
  return [
    row(
      'regression-shape',
      HISTORY,
      detail,
      ['test-defect', 'product-defect'],
      ['environment'],
    ),
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
