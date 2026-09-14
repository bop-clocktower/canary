// cluster -- what broke together, who owns it, and what to do about it. Pure.
//
// The one-pager's value is not the list of failing tests (the run log already
// has that). It is the SHAPE of the break: whether one thing broke in one
// place, or many things broke everywhere. Those two shapes want opposite
// responses, which is why the recommendation is derived from the shape rather
// than from the failure count.

const UNCATEGORIZED = 'uncategorized';

/** A test row counts as a failure when it did not pass. */
function isFailure(test) {
  const status = String(test?.status ?? '').toLowerCase();
  return (
    status === 'failed' || status === 'unexpected' || status === 'timedout'
  );
}

/**
 * @typedef {object} Cluster
 * @property {string} category
 * @property {object[]} tests
 */

/** Failures grouped by category, largest group first. */
function byCategory(failures) {
  const groups = new Map();
  for (const test of failures) {
    const category = test.failure_category || UNCATEGORIZED;
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(test);
  }
  // Ties broken by name so the one-pager is stable across runs -- a report that
  // reshuffles itself is a report nobody diffs.
  return [...groups.entries()]
    .map(([category, tests]) => ({ category, tests }))
    .sort(
      (a, b) =>
        b.tests.length - a.tests.length || a.category.localeCompare(b.category),
    );
}

/** Failure counts per owning area, busiest first. Areas are often absent. */
function byArea(failures) {
  const counts = new Map();
  for (const test of failures) {
    if (test.area) counts.set(test.area, (counts.get(test.area) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([area, count]) => ({ area, count }))
    .sort((a, b) => b.count - a.count || a.area.localeCompare(b.area));
}

/**
 * The response the break's shape argues for.
 *
 * @param {{area: string, count: number}[]} areas
 * @param {{commits: string[], bounded: boolean}} culpritRange
 */
function recommendFor(areas, culpritRange) {
  // No area data at all. A recommendation here would be derived from nothing,
  // which is exactly the confident-on-absent-data shape this repo keeps getting
  // burned by -- so it declines to make one.
  if (!areas.length) return 'investigate';

  // One place, one attributable commit: the cheap, complete fix is a revert.
  const commits = culpritRange?.commits ?? [];
  const attributable = culpritRange?.bounded === true && commits.length === 1;
  if (areas.length === 1 && attributable) return 'revert';

  // Several areas, or an un-attributable range: nothing is cleanly revertable,
  // so isolate the failures and keep the branch moving.
  return 'quarantine';
}

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
  const areas = byArea(failures);
  return {
    clusters: byCategory(failures),
    areas,
    // The busiest area, or null when nothing recorded one. With several areas
    // in play this is a pointer, not an owner -- which is why the
    // recommendation refuses to treat it as one.
    owningArea: areas[0]?.area ?? null,
    recommendation: recommendFor(areas, culpritRange),
  };
}
