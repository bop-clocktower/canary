// trust -- what `--apply` may act on, decided from sources a PR editor cannot change.
//
// The trial manifest lives in the PR body, and the trial branch and its base
// are the editor's too. So the ledger and the test source are read from the
// repository's default branch on origin, and the ledger path is the operator's
// (--ledger, or the default), never the manifest's.
//
// Which ticket a failing test's note may be written to, for its last blocker:
//
//   direct   its id is a ticket the trusted row names (the same first-source
//            rule the audit uses: `issue`, marker comment, `reason`, title).
//            Told automatically, through the trusted ref: nothing the manifest
//            says about the ticket is used.
//   hand-off its id is not named, and its `via` chain runs from a named ticket
//            to it. Only reading the tracker could confirm that, so it is a
//            CLAIM: the note is listed for a person, nothing is commented and
//            the row is not re-pointed. The row keeps its ticket, and the next
//            audit walks the chain again, so nothing is lost.
//   neither  refuses the whole settle.
//
// The manifest chooses what it claims, so the claim never earns a write: a
// forged target comes out listed or refused, and only a ticket the row names
// on the fetched default branch is written to. What this cannot vouch for: the
// run's results (it ran the editor's branch), and whether a named ticket's lift
// belongs to the trial. Jira projects and tags come from the operator's
// checkout, and `gh`'s repository may not be `origin`; see SKILL.md.

import { fetchBranchTip, withWorktree } from './git.mjs';
import { jiraReach } from './refs.mjs';
import { resolveGithubRepo } from './trackers.mjs';
import { viewOf } from './trust-view.mjs';

/** The identity two ledger rows share. */
export const sameRow = (a, b) =>
  a.test === b.test &&
  a.file === b.file &&
  a.kind === b.kind &&
  a.marker === b.marker;

/** A ticket id in one spelling: `#N` in this repository, GitHub's case folded. */
function ticketKey(id, githubRepo) {
  const text = String(id ?? '');
  if (text.startsWith('#')) return `${githubRepo}${text}`.toLowerCase();
  return text.includes('#') ? text.toLowerCase() : text;
}

/** Where a trusted ref is told and how a row is re-pointed at it, from the ref alone. */
function ticketOf(ref, githubRepo) {
  if (ref.tracker === 'jira') {
    const url = ref.base ? `${ref.base}/browse/${ref.key}` : '';
    return { id: ref.key, tracker: 'jira', url, ...jiraReach(ref) };
  }
  const repo = ref.repo ?? githubRepo;
  return {
    id: `${repo}#${ref.number}`,
    tracker: 'github',
    url: `https://github.com/${repo}/issues/${ref.number}`,
  };
}

/** A manifest row's copy on the default branch's ledger. */
function trustedRow(d, view) {
  const row = view.entries.find((e) => sameRow(e, d));
  if (!row)
    throw new Error(
      `trial manifest row for "${d.test}" is not on the default branch's ledger; refusing to settle`,
    );
  return row;
}

/**
 * `selectRows` groups rows by the marker they locate to, so a row with another
 * title is this lift's only if it locates to the same marker in the same file.
 */
function sharesMarker(r, own, view) {
  const marker = view.locate(own).markerLine;
  return (
    r.file === own.file &&
    Boolean(marker) &&
    view.locate(r).markerLine === marker
  );
}

/** The lift's rows on the default branch, each proven to be its own. */
function trustedRows(j, view) {
  const asked = Array.isArray(j.ledgerRows) ? j.ledgerRows : [];
  const rows = asked.map((d) => trustedRow(d, view));
  const isOwn = (r) => r.test === j.test && r.file === j.file;
  const own = rows.find(isOwn);
  if (!own)
    throw new Error(
      `trial manifest lift "${j.test}" has no ledger row of its own; refusing to settle`,
    );
  const stray = rows.find((r) => !isOwn(r) && !sharesMarker(r, own, view));
  if (stray)
    throw new Error(
      `trial manifest row for "${stray.test}" belongs to another marker than "${j.test}"; refusing to settle`,
    );
  return rows;
}

/** A chain from a ticket the row names to this very blocker. See the header. */
function claimsHandoff(leaf, isNamed) {
  const { via } = leaf;
  return Array.isArray(via) && via.at(-1) === leaf.id && isNamed(via[0]);
}

/** The ticket a failing lift may tell: a trusted one, or null for a hand-off claim. Throws otherwise. */
function targetFor(j, rows, view) {
  // `trial` selects only rows with a blocker, so this is not a real trial's
  // lift: it would settle with nobody told, or fail after the push.
  if (!Array.isArray(j.blockers) || !j.blockers.length)
    throw new Error(
      `trial manifest lift "${j.test}" failed but has no blocker to tell; refusing to settle`,
    );
  const leaf = j.blockers.at(-1);
  const named = rows.flatMap((r) => view.named(r));
  const keyOf = (id) => ticketKey(id, view.githubRepo);
  const isNamed = (id) => named.some((n) => keyOf(n.id) === keyOf(id));
  const direct = named.find((n) => keyOf(n.id) === keyOf(leaf.id));
  if (direct) return ticketOf(direct, view.githubRepo);
  if (claimsHandoff(leaf, isNamed)) return null;
  throw new Error(
    `trial manifest blocker for "${j.test}" is not named by its ledger row on the default branch, and no hand-off from a named ticket is claimed; refusing to settle`,
  );
}

/** The repository's default branch, as `gh` reports it. */
function defaultBranchOf(run, repo) {
  const r = run(
    'gh',
    [
      'repo',
      'view',
      '--json',
      'defaultBranchRef',
      '-q',
      '.defaultBranchRef.name',
    ],
    { cwd: repo },
  );
  const branch = r.status === 0 ? r.stdout.trim() : '';
  if (!branch)
    throw new Error(
      'cannot read the default branch to check the trial manifest against; refusing to settle',
    );
  return branch;
}

/**
 * `judged` with each lift's `trustedTarget` set: the only ticket a later step
 * may write to, or null. Set on every lift, so a value carried in from the
 * manifest never survives. Only a pass (rows dropped) and a fail (rows
 * re-pointed, a ticket told) act on the ledger, so only those are checked.
 * Throws, before anything is written, when the manifest disagrees.
 *
 * @param {{run: Function, repo: string, manifest: object, judged: object[],
 *          trust: {ledger: string, githubRepo?: string|null,
 *                  jiraProjects?: string[], tags?: string[]}}} input
 */
export function withTrustedTargets({
  run,
  repo,
  headRefName,
  manifest,
  judged,
  trust,
}) {
  if (manifest.ledger !== trust.ledger)
    throw new Error(
      `trial manifest ledger "${manifest.ledger}" is not the ledger this verdict was told to trust (${trust.ledger}); refusing to settle`,
    );
  const github = resolveGithubRepo({ run, repo, explicit: trust.githubRepo });
  if (!github.repo)
    throw new Error(
      `cannot tell which repository this trial is in (${github.why}); refusing to settle`,
    );
  const branch = defaultBranchOf(run, repo);
  // A settle pushes to the head, so this keeps it off the trust source itself.
  if (headRefName === branch)
    throw new Error(
      `PR head "${headRefName}" is the default branch, which a settle must not push to; refusing to settle`,
    );
  const tip = fetchBranchTip(run, repo, branch);
  const read = { options: ['--detach'], commit: tip };
  return withWorktree(run, repo, read, (work) => {
    const view = viewOf(work, trust, github.repo);
    return judged.map((j) => {
      const acts = j.outcome === 'pass' || j.outcome === 'fail';
      const rows = acts ? trustedRows(j, view) : [];
      const trustedTarget =
        j.outcome === 'fail' ? targetFor(j, rows, view) : null;
      return { ...j, trustedTarget };
    });
  });
}
