// jira -- the Jira adapter: read a ticket's state.
//
// Enabled per project by company.json `jira_projects`, with credentials from
// the environment, handed to curl on stdin and never in argv, and sent only to
// the configured CANARY_JIRA_BASE_URL. A project that is not configured, no
// credentials, or a ticket link on any other site abstains for that ticket.

import { parseJson } from './exec.mjs';

/** The origin of an https URL, or null for anything else. */
function httpsOrigin(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * The configured Jira site(s): CANARY_JIRA_BASE_URL (or JIRA_BASE_URL), one
 * URL or several separated by commas. These are the ONLY hosts credentials
 * are ever sent to.
 */
function jiraSites(env = process.env) {
  return String(env.CANARY_JIRA_BASE_URL || env.JIRA_BASE_URL || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/**
 * Where a ticket may be read with credentials, or why it may not. A ticket
 * URL's host only identifies the ticket: the request always goes to the
 * configured site, and a URL naming any other origin (a different host, port
 * or scheme) abstains. Anyone who can comment on a tracking issue can write a
 * `/browse/KEY-1` link, so a URL-derived host is never trusted with the token.
 *
 * @param {string|null|undefined} refBase the ticket URL's origin, if any
 * @param {string[]} sites jiraSites()
 * @returns {{base: string} | {why: string}}
 */
function jiraSiteFor(key, refBase, sites) {
  if (!sites.length)
    return { why: `no Jira site for ${key}: set CANARY_JIRA_BASE_URL` };
  const bad = sites.find((s) => !httpsOrigin(s));
  if (bad) {
    return {
      why: `CANARY_JIRA_BASE_URL ${bad} is not an https URL, so credentials are not sent for ${key}`,
    };
  }
  if (!refBase) return { base: sites[0] };
  const origin = httpsOrigin(refBase);
  const site = origin && sites.find((s) => httpsOrigin(s) === origin);
  if (site) return { base: site };
  return {
    why: `${key} links to ${refBase}, which is not the configured Jira site (${sites.join(', ')}), so it is not read with credentials`,
  };
}

/**
 * Whether a Jira ticket may be read, and where. `projects` is company.json
 * `jira_projects`; credentials come from the environment (CANARY_JIRA_EMAIL /
 * CANARY_JIRA_API_TOKEN, or the JIRA_* spellings), and the site is always the
 * configured CANARY_JIRA_BASE_URL (see jiraSiteFor).
 *
 * @returns {(ref: {key?: string, project?: string, base?: string|null}) =>
 *           {base: string, auth: string} | {why: string}}
 */
function jiraAccess({ projects = [], env = process.env }) {
  const configured = new Set(projects);
  const email = env.CANARY_JIRA_EMAIL || env.JIRA_EMAIL || '';
  const token = env.CANARY_JIRA_API_TOKEN || env.JIRA_API_TOKEN || '';
  const sites = jiraSites(env);
  // A curl config line, handed over on stdin so the token is never in argv. A
  // line break in either value would start a new config directive, so such
  // credentials are refused rather than quoted.
  const quote = (v) => v.replace(/["\\]/g, '\\$&');
  const auth = `user = "${quote(email)}:${quote(token)}"\n`;
  const injectable = /[\r\n]/.test(email + token);
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
    const site = jiraSiteFor(ref.key, ref.base, sites);
    if ('why' in site) return site;
    if (!email || !token) {
      return {
        why: `Jira is unreachable for ${ref.key}: set CANARY_JIRA_EMAIL and CANARY_JIRA_API_TOKEN`,
      };
    }
    if (injectable) {
      return {
        why: `Jira credentials contain a line break, so they are not sent for ${ref.key}`,
      };
    }
    return { base: site.base, auth };
  };
}

/** Resolutions that mean the defect was fixed; company.json `jira_fixed_resolutions` replaces them. */
const FIXED_RESOLUTIONS = ['Done', 'Fixed'];

/**
 * Jira adapter: reads a ticket's status category and resolution. Enabled per
 * project by company.json; anything `jiraAccess` refuses abstains with its
 * reason. A `done` ticket is resolved only when its resolution is one of
 * `fixedResolutions` (case-insensitive): Won't Do, Duplicate, Cannot
 * Reproduce and no resolution at all are done without being fixed.
 *
 * @param {{run: Function, projects?: string[], env?: Record<string, string|undefined>,
 *          curl?: string, fixedResolutions?: string[]}} opts
 */
export function jiraTracker({
  run,
  projects = [],
  env = process.env,
  curl = 'curl',
  fixedResolutions = FIXED_RESOLUTIONS,
}) {
  const access = jiraAccess({ projects, env });
  const fixed = new Set(fixedResolutions.map((r) => r.toLowerCase()));
  const cache = new Map();
  return function lookup(ref) {
    const ok = access(ref);
    if ('why' in ok) return { state: 'unknown', why: ok.why };
    if (!cache.has(ref.key))
      cache.set(ref.key, fetchJira(run, curl, { ...ok, fixed }, ref.key));
    return cache.get(ref.key);
  };
}

/** Jira's status categories, as this audit reads them. */
const JIRA_STATE = { done: 'resolved', new: 'open', indeterminate: 'open' };

/** A `done` ticket: resolved only when its resolution is in `fixed`. */
function doneState(fields, url, fixed) {
  const resolution = fields.resolution?.name ?? '';
  if (fixed.has(resolution.toLowerCase()))
    return {
      state: 'resolved',
      title: String(fields.summary ?? ''),
      url,
      handoff: [],
    };
  const as = resolution ? `as "${resolution}"` : 'with no resolution';
  return {
    state: 'unknown',
    why: `Jira ticket at ${url} is done ${as}, which is not a fix`,
    url,
  };
}

function jiraState(fields, url, fixed) {
  const state = JIRA_STATE[fields.status?.statusCategory?.key];
  const title = String(fields.summary ?? '');
  if (state === 'resolved') return doneState(fields, url, fixed);
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

function fetchJira(run, curl, site, key) {
  const { base, auth, fixed } = site;
  const url = `${base}/browse/${key}`;
  const api = `${base}/rest/api/2/issue/${encodeURIComponent(key)}?fields=status,resolution,assignee,summary`;
  const parsed = parseJson(
    run(
      curl,
      ['-sS', '--fail', '--proto', '=https', '--globoff', '-K', '-', api],
      { input: auth },
    ),
    `Jira ${key}`,
  );
  if (parsed.why) return { state: 'unknown', why: parsed.why, url };
  return jiraState(parsed.value.fields ?? {}, url, fixed);
}
