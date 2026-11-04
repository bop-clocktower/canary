// settle -- turn the trial PR into its final shape, from the verdict.
//
//   pass     keep the marker lifted, drop every ledger row for it
//   fail     restore the marker; when the blocker is a ticket the trusted row
//            names, re-point the rows' `issue` at it and comment on it; when it
//            is a claimed hand-off, list the note for a person (see trust.mjs)
//   flaky    restore the marker; the test goes to canary-flake-hunter
//   missing  / skipped: restore the marker and change nothing else
//
// Every touched file is rebuilt from the trial's base commit plus ONLY the
// passing lifts, so a restored marker comes back byte for byte however many
// lifts share its file. The rewrite is one commit pushed to the trial branch,
// from a throwaway worktree; a person reviews and merges it.

import * as ledgerIo from '../../canary-katana/scripts/ledger.mjs';
import {
  at,
  checkNotPartialClone,
  guardedRun,
  fetchBranchTip,
  insideRepo,
  must,
  withWorktree,
  writeAt,
  writeLifts,
} from './git.mjs';
import { commentFailures } from './notify.mjs';
import { sameRow, withTrustedTargets } from './trust.mjs';

/** Drop the passing tests' rows; re-point the failing tests' rows at their trusted ticket. */
function rewriteLedger(work, file, judged) {
  const doc = ledgerIo.load(at(work, file));
  const drop = judged
    .filter((j) => j.outcome === 'pass')
    .flatMap((j) => j.ledgerRows);
  doc.entries = doc.entries.filter((e) => !drop.some((d) => sameRow(e, d)));
  for (const j of judged.filter(
    (x) => x.outcome === 'fail' && x.trustedTarget,
  )) {
    const target = j.trustedTarget;
    for (const e of doc.entries)
      if (j.ledgerRows.some((d) => sameRow(e, d)))
        e.issue = target.url || target.id;
  }
  doc.schema_version = ledgerIo.SCHEMA_VERSION;
  writeAt(work, file, `${JSON.stringify(doc, null, 2)}\n`);
}

/** Every touched file as it was at `base`, plus only the passing lifts. */
function rebuildFiles(run, work, base, judged) {
  const files = [...new Set(judged.map((j) => j.file))];
  for (const f of files) {
    const shown = run('git', ['-C', work, 'show', `${base}:${f}`]);
    must(shown, `git show ${base}:${f}`);
    writeAt(work, f, shown.stdout); // untrimmed: byte for byte
  }
  writeLifts(
    work,
    judged.filter((j) => j.outcome === 'pass'),
  );
  return files;
}

/**
 * A Jira blocker's key must be well formed and the blocker's own id. Which
 * ticket a comment is written to is decided in trust.mjs, from the default
 * branch: a key this check passes still reaches a commenter only if the
 * trusted row names it.
 */
function checkJiraBlocker(b) {
  if (b.tracker !== 'jira') return;
  if (!/^[A-Z][A-Z0-9_]{1,9}-\d+$/.test(String(b.key)) || b.key !== b.id)
    throw new Error(
      `trial manifest blocker "${b.key}" is not a Jira key matching its id "${b.id}"; refusing to settle`,
    );
}

/**
 * Refuse a path through a .git directory, in the spellings git itself treats as
 * one on NTFS (trailing dots and spaces, an alternate stream, the short name).
 */
function checkNoDotGit(p) {
  const isDotGit = (seg) => /^(\.git[. ]*(:.*)?|git~1)$/i.test(seg);
  if (
    String(p ?? '')
      .split(/[\\/]/)
      .some(isDotGit)
  )
    throw new Error(
      `trial manifest path "${p}" names a .git directory; refusing to settle`,
    );
}

/**
 * Refuse a manifest that reaches outside `root`. The manifest lives in the PR
 * body, which anyone who can edit the PR controls, so every path it names is
 * resolved (symlinks included) and must stay strictly inside the tree, and
 * `base` must be a commit id: it is handed to `git show` as an argument.
 * Any escape refuses the whole settle, before anything is written.
 */
function checkManifest(root, manifest, judged) {
  if (!/^[0-9a-f]{7,64}$/.test(String(manifest.base ?? '')))
    throw new Error(
      `trial manifest base "${manifest.base}" is not a commit id; refusing to settle`,
    );
  judged.flatMap((j) => j.blockers ?? []).forEach(checkJiraBlocker);
  checkPaths(root, manifest, judged);
}

/** Each lift once, and every path it names inside the tree and outside .git. */
function checkPaths(root, manifest, judged) {
  for (const p of [manifest.ledger, ...judged.map((j) => j.file)])
    checkNoDotGit(p);
  // `selectRows` lifts a marker once; a repeat would tell its ticket repeatedly.
  const seen = new Set();
  for (const j of judged) {
    const key = JSON.stringify([j.file, j.test]);
    if (seen.has(key))
      throw new Error(
        `trial manifest lifts "${j.test}" more than once; refusing to settle`,
      );
    seen.add(key);
  }
  for (const p of [manifest.ledger, ...judged.map((j) => j.file)]) {
    if ('why' in insideRepo(root, p))
      throw new Error(
        `trial manifest path "${p}" escapes the trial worktree; refusing to settle`,
      );
  }
}

/**
 * Apply the verdict to the trial branch and tell the failing tests' tickets.
 * Returns the comment notes.
 */
export function applyVerdict({
  run: operatorRun,
  repo,
  trial,
  judged: asJudged,
  jiraComment,
  trust,
  now = new Date(),
}) {
  const { manifest, headRefName, url } = trial;
  checkManifest(repo, manifest, asJudged); // before any git call
  checkNotPartialClone(operatorRun, repo);
  const run = guardedRun(operatorRun, repo); // before any worktree
  // Then against the default branch, before the head is fetched or anything
  // is written. Everything below acts on what this returns.
  const judged = withTrustedTargets({
    run,
    repo,
    headRefName,
    manifest,
    judged: asJudged,
    trust,
  });
  withWorktree(
    run,
    repo,
    {
      options: ['--detach'],
      commit: fetchBranchTip(run, repo, headRefName),
    },
    (work) => {
      checkManifest(work, manifest, judged); // again, against the checked-out tree's symlinks
      const files = rebuildFiles(run, work, manifest.base, judged);
      rewriteLedger(work, manifest.ledger, judged);
      const git = (...args) =>
        must(run('git', ['-C', work, ...args]), `git ${args[0]}`);
      const passed = judged.filter((j) => j.outcome === 'pass').length;
      git('add', '--', ...files, manifest.ledger);
      const subject = `test: release ${passed} trial-passed test(s), re-quarantine ${judged.length - passed} (canary-unquarantine)`;
      git(
        'commit',
        '-m',
        subject,
        '-m',
        `Verdict read on ${now.toISOString()}.`,
      );
      // From the operator's repository, so a relative credential helper or ssh
      // command resolves there and never in the trial tree. Auth is untouched.
      const tip = git('rev-parse', 'HEAD');
      must(
        run('git', [
          '-C',
          repo,
          'push',
          'origin',
          `${tip}:refs/heads/${headRefName}`,
        ]),
        'git push',
      );
    },
  );
  return commentFailures({ run, repo, judged, prUrl: url, jiraComment });
}
