// config -- the company.json keys this skill reads: `jira_projects` (which
// Jira projects may be read and commented on), `jira_fixed_resolutions` (the
// Jira resolutions that mean fixed) and `quarantine_tags`, and how --tags
// overrides them.

import fs from 'node:fs';

import { DEFAULT_TAGS } from './markers.mjs';

const list = (v) => {
  if (Array.isArray(v)) return v.map(String);
  return typeof v === 'string'
    ? v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
};

/** company.json, or an empty config. A malformed file is an error, not a default. */
export function loadCompany(file) {
  if (!fs.existsSync(file)) return { jiraProjects: [], tags: null };
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tags = list(doc.quarantine_tags);
  const fixed = list(doc.jira_fixed_resolutions);
  return {
    jiraProjects: list(doc.jira_projects),
    tags: tags.length ? tags : null,
    fixedResolutions: fixed.length ? fixed : undefined,
  };
}

/** The quarantine tags: --tags, else company.json `quarantine_tags`, else the defaults. */
export function tagsFor(flag, company) {
  if (flag) return list(flag);
  return company.tags ?? DEFAULT_TAGS;
}
