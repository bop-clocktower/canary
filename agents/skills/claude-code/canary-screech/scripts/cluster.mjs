// cluster -- what broke together, who owns it, and what to do about it. Pure.
//
// The one-pager's value is not the list of failing tests (the run log already
// has that). It is the SHAPE of the break: whether one thing broke in one
// place, or many things broke everywhere. Those two shapes want opposite
// responses, which is why the recommendation is derived from the shape rather
// than from the failure count.

/** A test row counts as a failure when it did not pass. */
function isFailure(test) {
  const status = String(test?.status ?? '').toLowerCase();
  return (
    status === 'failed' || status === 'unexpected' || status === 'timedout'
  );
}

const UNCATEGORIZED = 'uncategorized';

/**
 * @typedef {object} Cluster
 * @property {string} category
 * @property {object[]} tests
 */

/**
 * Cluster a red run's failures and derive the response.
 *
 * @param {object} run the first red run
 * @param {{commits: string[], bounded: boolean}} culpritRange
 * @returns {{clusters: Cluster[], areas: {area: string, count: number}[],
 *           owningArea: string|null,
 *           recommendation: 'revert'|'quarantine'|'investigate'}}
 */
export function clusterFailures(run, culpritRange) {
  const failures = (run?.tests ?? []).filter(isFailure);

  const byCategory = new Map();
  const byArea = new Map();
  for (const test of failures) {
    const category = test.failure_category || UNCATEGORIZED;
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push(test);
    if (test.area) byArea.set(test.area, (byArea.get(test.area) ?? 0) + 1);
  }

  // Largest cluster first, ties broken by name so the one-pager is stable
  // across runs -- a report that reshuffles itself is a report nobody diffs.
  const clusters = [...byCategory.entries()]
    .map(([category, tests]) => ({ category, tests }))
    .sort(
      (a, b) =>
        b.tests.length - a.tests.length || a.category.localeCompare(b.category),
    );

  const areas = [...byArea.entries()]
    .map(([area, count]) => ({ area, count }))
    .sort((a, b) => b.count - a.count || a.area.localeCompare(b.area));

  // The busiest area, or null when nothing recorded one. With several areas in
  // play this is a pointer, not an owner -- which is why the recommendation
  // below refuses to treat it as one.
  const owningArea = areas[0]?.area ?? null;

  const commits = culpritRange?.commits ?? [];
  const bounded = culpritRange?.bounded === true;

  let recommendation;
  if (!areas.length) {
    // No area data at all. A recommendation here would be derived from nothing,
    // which is exactly the confident-on-absent-data shape this repo keeps
    // getting burned by -- so it declines to make one.
    recommendation = 'investigate';
  } else if (areas.length === 1 && bounded && commits.length === 1) {
    // One place, one attributable commit: the cheap, complete fix is a revert.
    recommendation = 'revert';
  } else {
    // Several areas, or an un-attributable range: nothing is cleanly
    // revertable, so isolate the failures and keep the branch moving.
    recommendation = 'quarantine';
  }

  return { clusters, areas, owningArea, recommendation };
}
