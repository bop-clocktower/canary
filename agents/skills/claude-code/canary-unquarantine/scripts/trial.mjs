// trial -- release candidates for one run of the suite's own CI, never for good.
//
// `trial` takes the audit's candidates and opens ONE draft pull request in
// the suite that lifts every one of their markers. Nothing is released by
// that: the PR exists so the suite's CI runs those tests live. `verdict` then
// reads that run, test by test, and `settle` rewrites the same PR:
//
//   pass   the marker stays lifted and the ledger row is dropped
//   fail   the marker is restored, the row re-pointed at the blocker that was
//          supposed to fix it, and that ticket told the test still fails
//   flaky  the marker is restored and the test handed to canary-flake-hunter
//          -- a test that passes on retry has not shown it is fixed
//
// The trial's plan travels in the PR body (an HTML comment), so `verdict`
// needs nothing but the PR number.

import { must, readAt, withWorktree, writeLifts } from './git.mjs';
import { embedManifest, planLift } from './lift.mjs';

/**
 * Which audited rows the trial lifts. Candidates always; abstained rows only
 * when asked for by name (`includeAbstained`), because the trial run is the
 * arbiter and an unreadable tracker is no reason never to ask it. Rows are
 * grouped by marker, so duplicate ledger rows lift one marker once.
 */
export function selectRows(result, { includeAbstained = false } = {}) {
  const wanted = new Set([
    'candidate',
    ...(includeAbstained ? ['abstain'] : []),
  ]);
  const byMarker = new Map();
  for (const r of result.rows) {
    if (!wanted.has(r.class) || !r.markerLine) continue;
    const k = `${r.file}:${r.markerLine}`;
    if (!byMarker.has(k)) byMarker.set(k, { ...r, ledgerRows: [] });
    const { index, test, file, kind, marker } = r;
    byMarker.get(k).ledgerRows.push({ index, test, file, kind, marker });
  }
  return [...byMarker.values()];
}

/** Plan every lift against the files at `root`; rows that cannot be lifted are set aside with the reason. */
export function planTrial(root, rows, tags) {
  const lifts = [];
  const refused = [];
  for (const r of rows) {
    const plan = planLift(readAt(root, r.file).split('\n'), r, tags);
    if ('why' in plan)
      refused.push({ test: r.test, file: r.file, why: plan.why });
    else lifts.push({ ...r, edits: plan.edits });
  }
  return { lifts, refused };
}

/** What the verdict needs to know about each lift, and nothing else. */
const manifestLift = (l) => ({
  test: l.test,
  file: l.file,
  class: l.class,
  markerLine: l.markerLine,
  edits: l.edits,
  // A Jira blocker keeps what the verdict's commenter needs to reach it.
  blockers: (l.blockers ?? []).map((b) => ({
    id: b.id,
    tracker: b.tracker,
    state: b.state,
    url: b.url ?? '',
    ...(b.tracker === 'jira'
      ? { key: b.key, project: b.project, base: b.base ?? null }
      : {}),
  })),
  ledgerRows: l.ledgerRows,
});

/** Lift, commit and push in the worktree; returns the lifts and the refusals. */
function liftAndPush(run, work, { rows, tags, branch }) {
  const { lifts, refused } = planTrial(work, rows, tags);
  if (!lifts.length) {
    const why =
      refused.map((r) => `${r.test}: ${r.why}`).join('; ') ||
      'no rows selected';
    throw new Error(`nothing to lift: ${why}`);
  }
  const files = writeLifts(work, lifts);
  const git = (...args) =>
    must(run('git', ['-C', work, ...args]), `git ${args[0]}`);
  git('add', '--', ...files);
  git(
    'commit',
    '-m',
    subjectFor(lifts.length),
    '-m',
    'A trial, not a release: the verdict step reads this run and rewrites the PR.',
  );
  git('push', '-u', 'origin', branch);
  return { lifts, refused };
}

const subjectFor = (n) =>
  `test: trial-release ${n} quarantined test(s) (canary-unquarantine)`;

/**
 * Open the trial PR from a throwaway worktree at HEAD. `run` is the injected
 * command runner.
 *
 * @returns {{url: string, branch: string, lifted: number, refused: object[]}}
 */
export function openTrial({
  repo,
  rows,
  tags,
  run,
  branch,
  prBase,
  ledger,
  now = new Date(),
}) {
  const base = must(
    run('git', ['-C', repo, 'rev-parse', 'HEAD']),
    'git rev-parse HEAD',
  );
  const name =
    branch ??
    `canary/unquarantine-trial-${now.toISOString().slice(0, 10)}-${base.slice(0, 7)}`;
  return withWorktree(
    run,
    repo,
    { options: ['-b', name], commit: base },
    (work) => {
      const { lifts, refused } = liftAndPush(run, work, {
        rows,
        tags,
        branch: name,
      });
      const manifest = {
        schema_version: 1,
        base,
        branch: name,
        ledger,
        lifts: lifts.map(manifestLift),
      };
      const args = [
        'pr',
        'create',
        '--draft',
        '--head',
        name,
        '--title',
        subjectFor(lifts.length),
        '--body',
        trialBody(manifest, refused),
      ];
      if (prBase) args.push('--base', prBase);
      const url = must(run('gh', args, { cwd: work }), 'gh pr create');
      return { url, branch: name, lifted: lifts.length, refused };
    },
  );
}

function trialBody(manifest, refused) {
  const waits = (l) =>
    l.blockers.length
      ? `; waits on ${l.blockers.map((b) => b.id).join(', ')}`
      : '';
  const list = manifest.lifts
    .map((l) => `- \`${l.file}\` — ${l.test} (${l.class}${waits(l)})`)
    .join('\n');
  const notLifted = refused.length
    ? `\n\nNot lifted (${refused.length}):\n\n${refused.map((r) => `- \`${r.file}\` — ${r.test}: ${r.why}`).join('\n')}`
    : '';
  return (
    `**Trial release — do not merge as is.** This draft lifts ${manifest.lifts.length} quarantined test(s) so this ` +
    `repository's own CI runs them live. When CI finishes, run \`canary-unquarantine verdict --pr <this PR>\`: ` +
    `tests that pass stay released and their ledger rows are dropped; tests that fail are re-quarantined and ` +
    `their ticket is told; flaky ones go to canary-flake-hunter.\n\nLifted:\n\n${list}${notLifted}\n\n${embedManifest(manifest)}\n`
  );
}
