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
// forged target comes out listed or refused, and only a ticket the default
// branch names is ever written to.

import * as ledgerIo from '../../canary-katana/scripts/ledger.mjs';
import { blockerRefs } from './audit.mjs';
import { at, must, withWorktree } from './git.mjs';
import { jiraReach } from './refs.mjs';
import { locate, readSource } from './markers.mjs';
import { resolveGithubRepo } from './trackers.mjs';

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

/** Read the manifest's lift against the default branch: its rows, and the tickets they name. */
function trustedRows(j, view) {
  const rows = (Array.isArray(j.ledgerRows) ? j.ledgerRows : []).map((d) => {
    const row = view.entries.find((e) => sameRow(e, d));
    if (!row)
      throw new Error(
        `trial manifest row for "${d.test}" is not on the default branch's ledger; refusing to settle`,
      );
    return row;
  });
  const own = rows.find((r) => r.test === j.test && r.file === j.file);
  if (!own)
    throw new Error(
      `trial manifest lift "${j.test}" has no ledger row of its own; refusing to settle`,
    );
  // `selectRows` groups rows by the marker they locate to, so a row with
  // another title is this lift's only if it locates to the same marker.
  const marker = view.locate(own).markerLine;
  for (const r of rows) {
    if (r.test === own.test && r.file === own.file) continue;
    if (r.file !== own.file || !marker || view.locate(r).markerLine !== marker)
      throw new Error(
        `trial manifest row for "${r.test}" belongs to another marker than "${j.test}"; refusing to settle`,
      );
  }
  return rows;
}

/** A chain from a ticket the row names to this very blocker. See the header. */
function claimsHandoff(leaf, isNamed) {
  const { via } = leaf;
  return (
    Array.isArray(via) &&
    via.length >= 2 &&
    via.at(-1) === leaf.id &&
    isNamed(via[0])
  );
}

/** The ticket a failing lift may tell: a trusted one, or null for a hand-off claim. Throws otherwise. */
function targetFor(j, rows, view) {
  const leaf = (j.blockers ?? []).at(-1);
  if (!leaf) return null;
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

/** Run `fn(work)` in a throwaway worktree of the default branch's tip. */
function atDefaultBranch(run, repo, fn) {
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
  must(run('git', ['-C', repo, 'fetch', 'origin', branch]), 'git fetch');
  const tip = must(
    run('git', ['-C', repo, 'rev-parse', 'FETCH_HEAD']),
    'git rev-parse FETCH_HEAD',
  );
  return withWorktree(run, repo, { options: ['--detach'], commit: tip }, fn);
}

/** The default branch as `targetFor` reads it. */
function viewOf(work, trust, githubRepo) {
  const { ledger, jiraProjects, tags } = trust;
  const located = (row) => locate(readSource(work, row.file), row, tags);
  return {
    githubRepo,
    entries: ledgerIo.load(at(work, ledger)).entries,
    locate: located,
    named: (row) => blockerRefs(row, located(row), jiraProjects).refs,
  };
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
export function withTrustedTargets({ run, repo, manifest, judged, trust }) {
  if (manifest.ledger !== trust.ledger)
    throw new Error(
      `trial manifest ledger "${manifest.ledger}" is not the ledger this verdict was told to trust (${trust.ledger}); refusing to settle`,
    );
  const github = resolveGithubRepo({ run, repo, explicit: trust.githubRepo });
  if (!github.repo)
    throw new Error(
      `cannot tell which repository this trial is in (${github.why}); refusing to settle`,
    );
  return atDefaultBranch(run, repo, (work) => {
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
