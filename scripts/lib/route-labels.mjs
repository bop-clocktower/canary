/**
 * The `route:*` label vocabulary — canary's half of the issue-fleet contract
 * (#1071).
 *
 * `issue-fleet` computes a route for every triaged issue and then has nowhere
 * to put it, so the routed queue — its terminal artifact, and the contract
 * every downstream fleet consumes — survives only as session transcript. The
 * upstream fix (Intense-Visions/harness-engineering#2183, tracked here as
 * #886) widens the route *enum*. It cannot fix the write end, because the
 * write end is THIS repository's label vocabulary. The skill itself is
 * vendored under `~/.claude/plugins/marketplaces/harness/` and is overwritten
 * by every harness CLI release, so the durable half has to live here.
 *
 * Pure by construction: no `gh`, no `fs`, no network. It takes issue objects
 * someone else fetched, so the partition logic is testable without a tracker
 * and the fetch policy (see D5 in the spec — never the label filter) is the
 * caller's single responsibility.
 */

export const ROUTE_PREFIX = 'route:';

/**
 * The downstream fleets an issue can be routed TO.
 *
 * Derived from the installed fleet roster rather than from the vendored
 * skill's comment, which lists only six (`adr | roadmap | pr | cicd | test |
 * cleanup`) and is exactly the omission #886 exists to fix. Four roster members
 * are deliberately absent: `fleet-command` conducts the fleets rather than
 * receiving issues; `issue` is the producer that computes the route — routing
 * an issue back to the router is a cycle; and `ideate` and `bug` are
 * issue-fleet's documented Non-destinations, whose labels were deleted under
 * #1216 (#1507).
 */
export const DESTINATIONS = [
  'adr',
  'cicd',
  'cleanup',
  'craft',
  'docs',
  'perf',
  'pr',
  'roadmap',
  'security',
  'test',
];

/**
 * A triaged issue with no legal destination.
 *
 * This is a label rather than the absence of one on purpose. Absence is
 * ambiguous — "nobody has looked at this yet" and "somebody looked and found
 * no destination" are different facts, and collapsing them is precisely the
 * silent drop this feature exists to prevent.
 */
export const UNROUTABLE = `${ROUTE_PREFIX}unroutable`;

/** Every label in the vocabulary: one per destination, plus unroutable. */
export const ROUTE_LABELS = [
  ...DESTINATIONS.map((d) => ROUTE_PREFIX + d),
  UNROUTABLE,
];

/**
 * Every route label on one issue, as bare names (`unroutable` included).
 *
 * `unroutable` is counted here rather than handled separately so that
 * `route:test` + `route:unroutable` reads as the disagreement it is — one pass
 * found a destination and another found none — instead of quietly resolving to
 * `test` because the destination label happened to be checked first.
 */
function routesOn(issue) {
  return (issue.labels ?? [])
    .map((l) => (typeof l === 'string' ? l : l.name))
    .filter((n) => n?.startsWith(ROUTE_PREFIX))
    .map((n) => n.slice(ROUTE_PREFIX.length));
}

/**
 * Partition issues into the four populations the denominator report needs.
 *
 * `examined` is the length of the INPUT, never of a filtered subset — it is
 * the denominator, and a denominator computed after filtering is the false
 * green this whole change is about. The four populations are disjoint and
 * exhaustive: their sizes sum to `examined`, which is what makes a silently
 * dropped issue impossible rather than merely discouraged.
 *
 * A `conflicted` issue carries two or more route labels, meaning two triage
 * passes disagreed about who owns it. It is reported, never resolved —
 * silently picking one corrupts the downstream queue with an answer nobody
 * chose.
 */
export function partitionByRoute(issues) {
  const partition = {
    examined: issues.length,
    routed: [],
    unroutable: [],
    untriaged: [],
    conflicted: [],
  };

  for (const issue of issues) {
    const routes = routesOn(issue);
    if (routes.length > 1) {
      partition.conflicted.push({ number: issue.number, routes });
    } else if (routes.length === 0) {
      partition.untriaged.push({ number: issue.number });
    } else if (routes[0] === 'unroutable') {
      partition.unroutable.push({ number: issue.number });
    } else {
      partition.routed.push({ number: issue.number, route: routes[0] });
    }
  }

  return partition;
}

/**
 * A `docs/roadmap.md` row linked to a GitHub issue (ADR 0043). The same
 * pattern as `ts/test/agents-roadmap-counts.test.ts`, with the slug captured,
 * so the two counts agree on what a row is.
 */
const ROADMAP_ROW = /\*\*External-ID:\*\*\s*github:(\S+?)#(\d+)/g;

const abstain = (reason) => ({ unrowed: null, reason });

/**
 * The `route:roadmap` issues with no `External-ID` row for `repo` (#1438).
 *
 * Returns `unrowed: null` with a reason, never `[]`, when the check cannot be
 * made: an unreadable roadmap, an unknown repo, or zero rows for this repo. A
 * row-less roadmap would otherwise say "every issue is missing", and a failed
 * read would say "none is", and neither would be a measurement.
 *
 * Only `routed` issues are checked. A conflicted issue carrying
 * `route:roadmap` is already reported as conflicted.
 */
export function unrowedRoadmapIssues({ routed, roadmapText, repo }) {
  if (roadmapText === null) return abstain('roadmap unreadable');
  if (!repo) return abstain('repo unknown');

  const rowed = new Set();
  for (const [, slug, n] of roadmapText.matchAll(ROADMAP_ROW)) {
    if (slug === repo) rowed.add(Number(n));
  }
  if (rowed.size === 0) return abstain(`zero External-ID rows for ${repo}`);

  const unrowed = routed
    .filter((r) => r.route === 'roadmap' && !rowed.has(r.number))
    .map((r) => r.number)
    .sort((a, b) => a - b);
  return { unrowed, reason: null };
}
