// settle -- turn the trial PR into its final shape, from the verdict.
//
//   pass     keep the marker lifted, drop every ledger row for it
//   fail     restore the marker, re-point the rows' `issue` at the blocker the
//            audit read as resolved, and comment on that ticket
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
  insideRepo,
  must,
  withWorktree,
  writeAt,
  writeLifts,
} from './git.mjs';
import { jiraProject } from './refs.mjs';

const sameRow = (a, b) =>
  a.test === b.test &&
  a.file === b.file &&
  a.kind === b.kind &&
  a.marker === b.marker;

/** The blocker a failing test is re-pointed at and its ticket told: the last leaf the audit reached. */
const lastBlocker = (j) => j.blockers[j.blockers.length - 1];

/** Drop the passing tests' rows; re-point the failing tests' rows at their blocker. */
function rewriteLedger(work, file, judged) {
  const doc = ledgerIo.load(at(work, file));
  const drop = judged
    .filter((j) => j.outcome === 'pass')
    .flatMap((j) => j.ledgerRows);
  doc.entries = doc.entries.filter((e) => !drop.some((d) => sameRow(e, d)));
  for (const j of judged.filter(
    (x) => x.outcome === 'fail' && lastBlocker(x),
  )) {
    const target = lastBlocker(j);
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
  run,
  repo,
  trial,
  judged,
  jiraComment,
  now = new Date(),
}) {
  const { manifest, headRefName, url } = trial;
  checkManifest(repo, manifest, judged); // before any git call
  must(run('git', ['-C', repo, 'fetch', 'origin', headRefName]), 'git fetch');
  withWorktree(
    run,
    repo,
    { options: ['--detach'], commit: 'FETCH_HEAD' },
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
      git('push', 'origin', `HEAD:refs/heads/${headRefName}`);
    },
  );
  return commentFailures({ run, repo, judged, prUrl: url, jiraComment });
}

const failureNote = (j, prUrl) =>
  `canary-unquarantine trial: \`${j.test}\` (\`${j.file}\`) was switched back on and **still fails** ` +
  `(${j.cases} case(s) in the run, ${prUrl}). It has been re-quarantined against this ticket. ` +
  `Its blocker was read as resolved, so either the fix has not reached the environment the suite runs ` +
  `against, or this ticket did not fix it.`;

/** One GitHub comment, through `gh issue comment`. */
function commentOnGithub(run, repo, target, body) {
  const gh = /^(?:([\w.-]+\/[\w.-]+))?#(\d+)$/.exec(target.id);
  if (!gh)
    return {
      commented: false,
      why: 'unrecognised ticket; comment by hand',
      body,
    };
  const args = [
    'issue',
    'comment',
    gh[2],
    '--body',
    body,
    ...(gh[1] ? ['-R', gh[1]] : []),
  ];
  const r = run('gh', args, { cwd: repo });
  return {
    commented: r.status === 0,
    why: r.status === 0 ? '' : (r.stderr || '').trim(),
  };
}

/**
 * One Jira comment, through the configured commenter when there is one. The
 * target comes from the PR-body manifest, which a PR editor can change, so the
 * project is re-derived from the key: the per-project gate checks the ticket
 * actually being written to.
 */
function commentOnJira(jiraComment, target, body) {
  const ref = { ...target, project: jiraProject(target.key ?? '') };
  const r = jiraComment
    ? jiraComment(ref, body)
    : { ok: false, why: 'Jira is not configured' };
  return r.ok
    ? { commented: true, why: '' }
    : { commented: false, why: `${r.why}; comment by hand`, body };
}

/**
 * Tell each failing test's blocker ticket. A ticket that cannot be told is
 * listed with the note, for a person to post.
 *
 * @param {{run: Function, repo: string, judged: object[], prUrl: string,
 *          jiraComment?: (ref: object, body: string) => {ok: boolean, why: string}}} input
 * @returns {{test: string, target?: string, commented: boolean, why: string, body?: string}[]}
 */
export function commentFailures({ run, repo, judged, prUrl, jiraComment }) {
  return judged
    .filter((j) => j.outcome === 'fail')
    .map((j) => {
      const target = lastBlocker(j);
      if (!target)
        return {
          test: j.test,
          commented: false,
          why: 'no blocker to comment on',
        };
      const body = failureNote(j, prUrl);
      const told =
        target.tracker === 'jira'
          ? commentOnJira(jiraComment, target, body)
          : commentOnGithub(run, repo, target, body);
      return { test: j.test, target: target.id, ...told };
    });
}
