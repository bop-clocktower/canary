// trackers -- ask a tracker what state a blocker is in.
//
// Each adapter answers one question for one reference and never guesses:
//
//   { state: 'open',     owner, title, url }
//   { state: 'resolved', title, url, handoff?: refs }  -- closed / done
//   { state: 'unknown',  why }                          -- could not read it
//
// `unknown` is the abstention. An unauthenticated `gh`, an unreachable Jira, a
// Jira project company.json does not configure: every one is a row the audit
// could not decide, reported with the reason, never folded into a result.
//
// This module is GitHub, built in through `gh`. Jira lives in jira.mjs and is
// enabled only when company.json lists the ticket's project in
// `jira_projects` AND credentials are in the environment; anything else
// abstains for that row.

import { failure, parseJson } from './exec.mjs';
import { handoffRefs } from './refs.mjs';

/**
 * The repository `#N` refers to: --github-repo, else the target's own remote.
 * @param {{run: Function, repo: string, explicit?: string|null, gh?: string}} opts
 */
export function resolveGithubRepo({ run, repo, explicit, gh = 'gh' }) {
  if (explicit) return { repo: explicit, why: '' };
  const r = run(
    gh,
    ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    { cwd: repo },
  );
  if (r.status === 0 && r.stdout.trim())
    return { repo: r.stdout.trim(), why: '' };
  return { repo: null, why: failure(r, 'gh repo view') };
}

/**
 * GitHub adapter. Reads issues and pull requests alike through the REST API.
 *
 * @param {{run: Function, gh?: string,
 *          defaultRepo?: string|null|(() => {repo: string|null, why: string})}} opts
 */
export function githubTracker({ run, gh = 'gh', defaultRepo }) {
  const cache = new Map();
  let fallback = null;
  // Resolved on first use: an audit whose rows name no bare `#N` never needs
  // to ask which repository it is in.
  const resolveDefault = () =>
    (fallback ??=
      typeof defaultRepo === 'function'
        ? defaultRepo()
        : { repo: defaultRepo ?? null, why: '' });
  function lookup(ref, ctx = {}) {
    const repo = ref.repo ?? resolveDefault().repo;
    if (!repo) {
      return {
        state: 'unknown',
        why: `cannot tell which repository ${ref.id} is in (${resolveDefault().why || 'pass --github-repo'})`,
      };
    }
    const id = `${repo}#${ref.number}`;
    if (!cache.has(id)) cache.set(id, fetchIssue(run, gh, repo, ref.number));
    const issue = cache.get(id);
    if (issue.state !== 'resolved') return { ...issue, id };
    const handoff = handoffRefs(issue.raw, {
      title: ctx.title,
      self: `#${ref.number}`,
      jiraProjects: ctx.jiraProjects,
    })
      .filter((r) => r.id !== id)
      .map((r) =>
        r.tracker === 'github' && !r.repo
          ? { ...r, repo, id: `${repo}#${r.number}` }
          : r,
      );
    return { ...issue, id, raw: undefined, handoff };
  }
  lookup.repo = () => (fallback ? fallback.repo : null);
  return lookup;
}

/** A closed issue's comments (NDJSON from `--jq '.[] | {body}'`), or why not. */
function readComments(run, gh, repo, number) {
  const c = run(gh, [
    'api',
    '--paginate',
    `repos/${repo}/issues/${number}/comments`,
    '--jq',
    '.[] | {body}',
  ]);
  if (c.status !== 0) return { why: failure(c, 'gh api') };
  const lines = c.stdout.split('\n').filter((l) => l.trim());
  return {
    comments: lines.map(
      (l) =>
        parseJson({ status: 0, stdout: l }, 'comment').value ?? { body: '' },
    ),
  };
}

/** `@a, @b` for an issue's assignees, or `unassigned`. */
const ghOwner = (issue) =>
  (issue.assignees ?? []).map((a) => `@${a.login}`).join(', ') || 'unassigned';

function fetchIssue(run, gh, repo, number) {
  const url = `https://github.com/${repo}/issues/${number}`;
  const unknown = (why) => ({ state: 'unknown', why, url });
  const parsed = parseJson(
    run(gh, ['api', `repos/${repo}/issues/${number}`]),
    `gh api ${repo}#${number}`,
  );
  if (parsed.why) return unknown(parsed.why);
  const issue = parsed.value;
  const title = String(issue.title ?? '');
  if (issue.state === 'open')
    return { state: 'open', owner: ghOwner(issue), title, url };
  if (issue.state !== 'closed')
    return unknown(`${repo}#${number} has unrecognised state "${issue.state}"`);
  // A closed issue may have been handed off, so its comments are part of the
  // answer. If they cannot be read, the hand-off cannot be ruled out -- and
  // closed-to-upstream is not fixed -- so the whole lookup abstains.
  const read = readComments(run, gh, repo, number);
  if (read.why) {
    return unknown(
      `${repo}#${number} is closed but its comments could not be read to rule out a hand-off (${read.why})`,
    );
  }
  return {
    state: 'resolved',
    title,
    url,
    raw: { body: String(issue.body ?? ''), comments: read.comments },
  };
}
