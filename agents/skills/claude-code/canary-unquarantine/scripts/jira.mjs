// jira -- the Jira adapter: read a ticket's state, and comment on it.
//
// Enabled per project by company.json `jira_projects`, with credentials from
// the environment, handed to curl on stdin and never in argv. A project that
// is not configured, or no credentials, abstains for that ticket.

import { failure, parseJson } from './exec.mjs';

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

/**
 * Post a comment on a Jira ticket (the verdict's "tell the ticket"), under the
 * same per-project gate and stdin-only credentials as the reader.
 *
 * @param {{run: Function, projects?: string[], env?: Record<string, string|undefined>,
 *          curl?: string}} opts
 * @returns {(ref: object, body: string) => {ok: boolean, why: string}}
 */
export function jiraCommenter({
  run,
  projects = [],
  env = process.env,
  curl = 'curl',
}) {
  const access = jiraAccess({ projects, env });
  return (ref, body) => {
    const ok = access(ref);
    if ('why' in ok) return { ok: false, why: ok.why };
    const api = `${ok.base}/rest/api/2/issue/${encodeURIComponent(ref.key)}/comment`;
    const json = JSON.stringify({ body });
    const config = `${ok.auth}header = "Content-Type: application/json"\ndata = ${JSON.stringify(json)}\n`;
    const r = run(curl, ['-sS', '--fail', '-X', 'POST', '-K', '-', api], {
      input: config,
    });
    return r.status === 0
      ? { ok: true, why: '' }
      : { ok: false, why: failure(r, `Jira comment on ${ref.key}`) };
  };
}

/** Jira's status categories, as this audit reads them. */
// Null-prototype, so a category named like an Object.prototype key reads as unknown.
const JIRA_STATE = Object.assign(Object.create(null), {
  done: 'resolved',
  new: 'open',
  indeterminate: 'open',
});

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
