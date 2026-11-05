// notify -- tell a failing test's ticket, or list the note for a person.
//
// Only a lift's `trustedTarget` is ever written to; see trust.mjs for how one
// is earned. Everything else about a blocker is the manifest's claim.

import { jiraProject } from './refs.mjs';
import { noteField } from './report.mjs';

/** The blocker the manifest says a failing test waits on: the last leaf the audit reached. */
const lastBlocker = (j) => j.blockers[j.blockers.length - 1];

const failureNote = (j, prUrl) =>
  `canary-unquarantine trial: \`${noteField(j.test)}\` (\`${noteField(j.file)}\`) was switched back on and **still fails** ` +
  `(${j.cases} case(s) in the run, ${prUrl}). ` +
  (j.trustedTarget
    ? `It has been re-quarantined against this ticket. `
    : `It has been re-quarantined, and its ledger row still reaches this ticket through a hand-off. `) +
  `Its blocker was read as resolved, so either the fix has not reached the environment the suite runs ` +
  `against, or this ticket did not fix it.`;

/** A hand-off leaf: not verified at verdict time, so it is left to a person. */
const listedForPerson = (j, leaf, body) => ({
  test: noteField(j.test),
  target: noteField(leaf.id),
  commented: false,
  why: 'a claimed hand-off the ledger cannot vouch for; check it and comment by hand',
  body,
});

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
 * Tell each failing test's trusted ticket. A ticket that cannot be told, or a
 * blocker with no `trustedTarget` (a claimed hand-off), is listed with the
 * note for a person to post. Only `trustedTarget` is ever written to.
 *
 * @param {{run: Function, repo: string, judged: object[], prUrl: string,
 *          jiraComment?: (ref: object, body: string) => {ok: boolean, why: string}}} input
 * @returns {{test: string, target?: string, commented: boolean, why: string, body?: string}[]}
 */
export function commentFailures({ run, repo, judged, prUrl, jiraComment }) {
  return judged
    .filter((j) => j.outcome === 'fail')
    .map((j) => {
      const leaf = lastBlocker(j);
      if (!leaf)
        return {
          test: noteField(j.test),
          commented: false,
          why: 'no blocker to comment on',
        };
      const body = failureNote(j, prUrl);
      const target = j.trustedTarget;
      if (!target) return listedForPerson(j, leaf, body);
      const told =
        target.tracker === 'jira'
          ? commentOnJira(jiraComment, target, body)
          : commentOnGithub(run, repo, target, body);
      return { test: noteField(j.test), target: target.id, ...told };
    });
}
