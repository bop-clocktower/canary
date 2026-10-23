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
// GitHub is built in (through `gh`). Jira is enabled only when company.json
// lists the ticket's project in `jira_projects` AND credentials are in the
// environment; anything else abstains for that row.
//
// The command runner is injected so tests drive both adapters with no network.

import { spawnSync } from 'node:child_process';

import { handoffRefs } from './refs.mjs';

/** Default runner: a synchronous spawn, never through a shell. */
export function spawnRunner(cmd, args, { input, cwd } = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    input,
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    error: r.error ? r.error.message : '',
  };
}

const firstLine = (s) =>
  String(s ?? '')
    .trim()
    .split('\n')[0];

function failure(r, what) {
  if (r.error) return `${what}: ${r.error}`;
  return `${what} exited ${r.status}: ${firstLine(r.stderr) || firstLine(r.stdout) || 'no output'}`;
}

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

/** Parse a `gh` JSON answer, or explain why it could not be. */
function parseJson(r, what) {
  if (r.status !== 0) return { why: failure(r, what) };
  try {
    return { value: JSON.parse(r.stdout) };
  } catch (exc) {
    return { why: `${what} returned unparseable JSON: ${exc.message}` };
  }
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

/**
 * Whether a Jira ticket may be read, and where. `projects` is company.json
 * `jira_projects`; credentials come from the environment (CANARY_JIRA_EMAIL /
 * CANARY_JIRA_API_TOKEN, or the JIRA_* spellings), and the site from the
 * ref's own URL or CANARY_JIRA_BASE_URL.
 *
 * @returns {(ref: {key?: string, project?: string, base?: string|null}) =>
 *           {base: string, auth: string} | {why: string}}
 */
function jiraAccess({ projects = [], env = process.env }) {
  const configured = new Set(projects);
  const email = env.CANARY_JIRA_EMAIL || env.JIRA_EMAIL || '';
  const token = env.CANARY_JIRA_API_TOKEN || env.JIRA_API_TOKEN || '';
  const fallbackBase = env.CANARY_JIRA_BASE_URL || env.JIRA_BASE_URL || '';
  // A curl config line, handed over on stdin so the token is never in argv.
  const quote = (v) => v.replace(/["\\]/g, '\\$&');
  const auth = `user = "${quote(email)}:${quote(token)}"\n`;
  return (ref) => {
    if (!configured.size) {
      return {
        why: `Jira is not configured: company.json has no jira_projects, so ${ref.key} cannot be read`,
      };
    }
    if (!configured.has(ref.project ?? '')) {
      return {
        why: `Jira project ${ref.project} is not in company.json jira_projects (${[...configured].join(', ')}), so ${ref.key} cannot be read`,
      };
    }
    const base = (ref.base || fallbackBase).replace(/\/+$/, '');
    if (!base)
      return { why: `no Jira site for ${ref.key}: set CANARY_JIRA_BASE_URL` };
    if (!email || !token) {
      return {
        why: `Jira is unreachable for ${ref.key}: set CANARY_JIRA_EMAIL and CANARY_JIRA_API_TOKEN`,
      };
    }
    return { base, auth };
  };
}

/**
 * Jira adapter: reads a ticket's status category. Enabled per project by
 * company.json; anything `jiraAccess` refuses abstains with its reason.
 *
 * @param {{run: Function, projects?: string[], env?: Record<string, string|undefined>,
 *          curl?: string}} opts
 */
export function jiraTracker({
  run,
  projects = [],
  env = process.env,
  curl = 'curl',
}) {
  const access = jiraAccess({ projects, env });
  const cache = new Map();
  return function lookup(ref) {
    const ok = access(ref);
    if ('why' in ok) return { state: 'unknown', why: ok.why };
    if (!cache.has(ref.key))
      cache.set(ref.key, fetchJira(run, curl, ok, ref.key));
    return cache.get(ref.key);
  };
}

/** Jira's status categories, as this audit reads them. */
const JIRA_STATE = { done: 'resolved', new: 'open', indeterminate: 'open' };

function jiraState(fields, url) {
  const state = JIRA_STATE[fields.status?.statusCategory?.key];
  const title = String(fields.summary ?? '');
  if (state === 'resolved') return { state, title, url, handoff: [] };
  if (state === 'open')
    return {
      state,
      owner: fields.assignee?.displayName ?? 'unassigned',
      title,
      url,
    };
  return {
    state: 'unknown',
    why: `Jira ticket at ${url} has no recognisable status category`,
    url,
  };
}

function fetchJira(run, curl, { base, auth }, key) {
  const url = `${base}/browse/${key}`;
  const api = `${base}/rest/api/2/issue/${encodeURIComponent(key)}?fields=status,assignee,summary`;
  const parsed = parseJson(
    run(curl, ['-sS', '--fail', '-K', '-', api], { input: auth }),
    `Jira ${key}`,
  );
  if (parsed.why) return { state: 'unknown', why: parsed.why, url };
  return jiraState(parsed.value.fields ?? {}, url);
}
