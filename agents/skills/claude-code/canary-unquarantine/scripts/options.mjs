// options -- canary-unquarantine's flags, help text and company.json keys,
// kept out of cli.mjs so the entry point stays a dispatcher.
//
// company.json keys read: `jira_projects` (which Jira projects may be read and
// commented on), `jira_fixed_resolutions` (the Jira resolutions that mean
// fixed) and `quarantine_tags` (overridden by --tags).

import fs from 'node:fs';

import { DEFAULT_TAGS } from './markers.mjs';

export const USAGE = `usage: canary-unquarantine [-h] [{audit,trial,verdict,migrate,quarantine}]
                           [--repo PATH]
                           [--ledger PATH] [--company PATH]
                           [--github-repo OWNER/NAME] [--tags LIST]
                           [--include-abstained] [--yes] [--branch NAME]
                           [--pr-base BRANCH] [--pr N] [--results PATH]
                           [--artifact NAME] [--apply] [--json] [--strict]
                           [--no-scan] [--file PATH] [--test TITLE]
                           [--cause CAUSE] [--issue REF] [--expiry DATE]
                           [--as-tag]

Release quarantined tests through a trial run of their own CI, never on
ticket state alone.

commands:
  audit                  classify every ledger row: candidate, blocked,
                         stale, unlinked or abstained (default; read-only)
  trial                  show the trial plan; with --yes, open one draft PR
                         that lifts every candidate's marker
  verdict                read the trial PR's CI per test; with --apply,
                         release passes and re-quarantine the rest
  migrate                show the ledger rows every unledgered marker (a
                         tag, a bare skip) becomes; with --yes, append them
  quarantine             switch one test off: write its marker and its
                         ledger row together

options:
  -h, --help             show this help message and exit
  --repo PATH            the test suite repository (default: .)
  --ledger PATH          ledger (default: <repo>/.canary/quarantine.json)
  --company PATH         company.json (default: <repo>/.canary/company.json)
  --github-repo OWNER/NAME
                         repository a bare #N refers to (default: the
                         repo's own GitHub remote, via gh)
  --tags LIST            comma-separated quarantine tags (default:
                         company.json quarantine_tags, else ${DEFAULT_TAGS.join(',')})
  --include-abstained    trial: also lift rows whose tracker could not be
                         read (the trial run is the arbiter)
  --yes                  trial, migrate: the confirm; without it nothing is
                         written
  --branch NAME          trial: branch name for the trial PR
  --pr-base BRANCH       trial: base branch of the trial PR (default: the
                         repository's default branch)
  --pr N                 verdict: the trial PR
  --results PATH         verdict: Playwright JSON or JUnit XML results (a
                         file or a directory) from the trial run
  --artifact NAME        verdict: download results from the trial run's
                         CI artifact NAME instead
  --apply                verdict: rewrite the trial PR and comment on
                         failing tickets; without it nothing is written
  --json                 emit machine-readable output
  --strict               exit 1 when something needs action, 3 when the
                         command abstained
  --no-scan              audit: do not scan for unledgered markers
  --file PATH            quarantine: the test file (repo-relative)
  --test TITLE           quarantine: the test's title
  --cause CAUSE          quarantine: flaky, product-defect, blocked-data,
                         pending-feature or obsolete
  --issue REF            quarantine: the ticket it waits on (required for
                         product-defect, blocked-data, pending-feature)
  --expiry DATE          quarantine: when the quarantine should be revisited
  --as-tag               quarantine: add the first quarantine tag to the
                         title instead of a .skip marker`;

export const CLI_SPEC = {
  prog: 'canary-unquarantine',
  booleans: {
    '--json': 'json',
    '--strict': 'strict',
    '--no-scan': 'noScan',
    '--include-abstained': 'includeAbstained',
    '--yes': 'yes',
    '--apply': 'apply',
    '--as-tag': 'asTag',
  },
  values: {
    '--repo': { key: 'repo' },
    '--ledger': { key: 'ledger' },
    '--company': { key: 'company' },
    '--github-repo': { key: 'githubRepo' },
    '--tags': { key: 'tags' },
    '--branch': { key: 'branch' },
    '--pr-base': { key: 'prBase' },
    '--pr': { key: 'pr', type: 'int' },
    '--results': { key: 'results' },
    '--artifact': { key: 'artifact' },
    '--file': { key: 'file' },
    '--test': { key: 'test' },
    '--cause': { key: 'cause' },
    '--issue': { key: 'issue' },
    '--expiry': { key: 'expiry' },
  },
  defaults: { repo: '.' },
  positionals: { key: 'command', defaults: ['audit'] },
};

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
