// audit -- read every quarantine, find what it waits on, and say which ones
// are ready to be tried again.
//
// Classes (one per ledger row):
//
//   candidate  the blocker is resolved -- ready for a trial release
//   blocked    the blocker is open; its owner is named
//   stale      a ledger row whose marker is not in the code any more
//   unlinked   a row that names no blocker anywhere
//   abstain    the tracker could not be read; NEVER reported as clear
//   removed    a deletion record (katana `removed`): the test is gone, there
//              is no marker to lift, so it is listed and not released
//
// "Resolved" is deliberately narrow. A closed GitHub issue whose thread says
// the finding was filed somewhere else ("Filed as UP-123") is NOT resolved:
// it resolves to that upstream ticket, and the row waits on that ticket's
// state. Closing a tracking issue because the defect moved upstream is the
// common case, and reading it as "fixed" would release a test the platform
// still fails.

import { extractRefs, idTokens, pickBlocker } from './refs.mjs';
import { locate, readSource, runtimeCallee } from './markers.mjs';
import { scanMarkers } from './scan.mjs';

const CLASSES = [
  'candidate',
  'blocked',
  'stale',
  'unlinked',
  'abstain',
  'removed',
];

/** How far a chain of hand-offs is followed before the audit gives up on it. */
export const MAX_HANDOFF_DEPTH = 4;

/**
 * The blocker refs for one row, from the first source that names any:
 * the ledger's `issue` field, the comment above the marker, the ledger
 * `reason`, then the title.
 */
function blockerRefs(row, loc, jiraProjects) {
  const exclude = idTokens(row.test);
  const sources = [
    ['issue', row.issue, { anyBareJira: true }],
    ['comment', loc.context, {}],
    ['reason', row.reason, {}],
    ['title', row.test, {}],
  ];
  for (const [source, text, extra] of sources) {
    if (!text) continue;
    const { refs, anchored } = pickBlocker(text, {
      jiraProjects,
      exclude,
      ...extra,
    });
    if (refs.length) return { source, anchored, refs };
  }
  return { source: null, anchored: false, refs: [] };
}

/**
 * Resolve one ref to its terminal blocker(s), following hand-offs from closed
 * issues. Every leaf carries the chain it was reached through.
 */
export function resolveRef(ref, lookup, ctx, via = [], depth = 0) {
  const chain = [...via, ref.id];
  if (via.includes(ref.id)) {
    return [
      {
        id: ref.id,
        via: chain,
        state: 'unknown',
        why: `hand-off cycle: ${chain.join(' -> ')}`,
      },
    ];
  }
  const tracker = lookup[ref.tracker];
  const answer = tracker
    ? tracker(ref, ctx)
    : { state: 'unknown', why: `no ${ref.tracker} adapter` };
  // An adapter may qualify the id (`#12` -> `owner/repo#12`); the chain then
  // carries the qualified form so a hand-off back to the same issue is a cycle.
  const id = answer.id ?? ref.id;
  const qualified = [...via, id];
  const leaf = { tracker: ref.tracker, ...answer, id, via: qualified };
  delete leaf.handoff;
  if (via.includes(id)) {
    return [
      {
        ...leaf,
        state: 'unknown',
        why: `hand-off cycle: ${qualified.join(' -> ')}`,
      },
    ];
  }
  if (answer.state !== 'resolved' || !answer.handoff?.length) return [leaf];
  if (depth + 1 >= MAX_HANDOFF_DEPTH) {
    return [
      {
        ...leaf,
        state: 'unknown',
        why: `hand-off chain longer than ${MAX_HANDOFF_DEPTH}: ${qualified.join(' -> ')}`,
      },
    ];
  }
  return answer.handoff.flatMap((next) =>
    resolveRef(next, lookup, ctx, qualified, depth + 1),
  );
}

/** Combine leaves: one open blocker decides; else any unknown abstains. */
export function combine(leaves) {
  if (leaves.some((l) => l.state === 'open')) return 'blocked';
  if (leaves.some((l) => l.state === 'unknown')) return 'abstain';
  return 'candidate';
}

const pairKey = (file, test) => `${file}\u0000${test}`;

/** A katana `removed` row: a phantom when the test is still there, else a record. */
function removedRow(base, loc, file) {
  if (loc.found) {
    return {
      ...base,
      class: 'stale',
      line: loc.line,
      why: `recorded as removed, but the test is still in ${file} (a phantom removal)`,
    };
  }
  return {
    ...base,
    class: 'removed',
    why: 'a deletion record: the test is gone, so there is no marker to lift',
  };
}

/** A marked row: find what it waits on, ask the trackers, combine. */
function trackedRow(row, base, loc, ctx) {
  const where = {
    line: loc.line,
    markerLine: loc.markerLine,
    match: loc.match,
    runtime: Boolean(runtimeCallee(row.marker)),
  };
  const found = blockerRefs(row, loc, ctx.jiraProjects);
  if (!found.refs.length) {
    const why =
      'no issue field, and no ticket reference in the comment above the marker, the reason or the title';
    return { ...base, ...where, class: 'unlinked', why };
  }
  const resolveCtx = { title: row.test, jiraProjects: ctx.jiraProjects };
  const leaves = found.refs.flatMap((ref) =>
    resolveRef(ref, ctx.lookup, resolveCtx),
  );
  const cls = combine(leaves);
  const named = found.refs.map((r) => r.id);
  return {
    ...base,
    ...where,
    class: cls,
    source: found.source,
    named,
    blockers: leaves,
    why: explain(cls, leaves),
  };
}

/** Classify one ledger row. */
function auditRow(row, index, ctx) {
  const base = {
    index,
    test: row.test,
    file: row.file,
    kind: row.kind,
    marker: row.marker,
    issue: row.issue ?? '',
  };
  const loc = locate(ctx.source(row.file), row, ctx.tags);
  if (row.kind === 'removed') return removedRow(base, loc, row.file);
  if (!loc.marked)
    return { ...base, class: 'stale', line: loc.line, why: loc.why };
  return trackedRow(row, base, loc, ctx);
}

function explain(cls, leaves) {
  const describe = (l) => {
    const via =
      l.via.length > 1 ? ` (via ${l.via.slice(0, -1).join(' -> ')})` : '';
    if (l.state === 'open') return `${l.id} is open, owner ${l.owner}${via}`;
    if (l.state === 'resolved') return `${l.id} is resolved${via}`;
    return `${l.id}: ${l.why}${via}`;
  };
  const pick =
    cls === 'blocked'
      ? leaves.filter((l) => l.state === 'open')
      : cls === 'abstain'
        ? leaves.filter((l) => l.state === 'unknown')
        : leaves;
  return pick.map(describe).join('; ');
}

/**
 * Run the audit.
 *
 * @param {{repo: string, rows: object[], lookup: {github?: Function, jira?: Function},
 *          jiraProjects?: string[], tags?: string[], scan?: boolean}} input
 */
export function audit({
  repo,
  rows,
  lookup,
  jiraProjects = [],
  tags,
  scan = true,
}) {
  const sources = new Map();
  const source = (file) => {
    if (!sources.has(file)) sources.set(file, readSource(repo, file));
    return sources.get(file);
  };
  const ctx = { source, lookup, jiraProjects, tags };
  const results = rows.map((row, i) => auditRow(row, i, ctx));

  const seen = new Map();
  for (const r of results) {
    const k = `${pairKey(r.file, r.test)}\u0000${r.kind}\u0000${r.marker}`;
    if (seen.has(k)) r.duplicateOf = seen.get(k);
    else seen.set(k, r.index);
  }

  const unledgered = scan
    ? findUnledgered(repo, rows, results, tags, jiraProjects)
    : [];
  const counts = Object.fromEntries(CLASSES.map((c) => [c, 0]));
  for (const r of results) counts[r.class] += 1;
  const denominator = {
    rows_read: rows.length,
    resolved: counts.candidate + counts.blocked,
    abstained: counts.abstain,
    not_tracker_questions: counts.stale + counts.unlinked + counts.removed,
  };
  return {
    rows: results,
    unledgered,
    counts,
    denominator,
    verdict: verdictOf(denominator, counts, unledgered),
  };
}

/** Markers in code that no ledger row accounts for. */
function findUnledgered(repo, rows, results, tags, jiraProjects) {
  const byLine = new Set(
    results.filter((r) => r.markerLine).map((r) => `${r.file}:${r.markerLine}`),
  );
  const titles = rows.map((r) => [r.file, r.test]);
  return scanMarkers(repo, tags)
    .filter((m) => !byLine.has(`${m.file}:${m.markerLine}`))
    .filter(
      (m) =>
        !titles.some(
          ([f, t]) => f === m.file && (m.test === t || m.test.includes(t)),
        ),
    )
    .map((m) => ({
      ...m,
      names: extractRefs(m.context, {
        jiraProjects,
        exclude: idTokens(m.test),
      }).map((r) => r.id),
    }));
}

/**
 * The verdict, and the one rule that matters most: zero rows read, or any
 * row abstained, is never "clear".
 */
export function verdictOf(den, counts, unledgered) {
  const actionable =
    counts.candidate + counts.stale + counts.unlinked + unledgered.length;
  if (den.rows_read === 0)
    return { status: 'abstained', actionable, reason: 'zero ledger rows read' };
  if (den.abstained > 0)
    return {
      status: 'abstained',
      actionable,
      reason: `${den.abstained} row(s) could not be resolved`,
    };
  if (actionable > 0) return { status: 'action', actionable, reason: '' };
  return { status: 'clear', actionable: 0, reason: '' };
}
