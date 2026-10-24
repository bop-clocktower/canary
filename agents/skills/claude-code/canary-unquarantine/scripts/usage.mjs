// usage -- canary-unquarantine's flags and help text, kept out of cli.mjs so
// the entry point stays a dispatcher.

import { DEFAULT_TAGS } from './markers.mjs';

export const USAGE = `usage: canary-unquarantine [-h] [{audit,trial,verdict}] [--repo PATH]
                           [--ledger PATH] [--company PATH]
                           [--github-repo OWNER/NAME] [--tags LIST]
                           [--include-abstained] [--yes] [--branch NAME]
                           [--pr-base BRANCH] [--pr N] [--results PATH]
                           [--artifact NAME] [--apply] [--json] [--strict]
                           [--no-scan]

Release quarantined tests through a trial run of their own CI, never on
ticket state alone.

commands:
  audit                  classify every ledger row: candidate, blocked,
                         stale, unlinked or abstained (default; read-only)
  trial                  show the trial plan; with --yes, open one draft PR
                         that lifts every candidate's marker
  verdict                read the trial PR's CI per test; with --apply,
                         release passes and re-quarantine the rest

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
  --yes                  trial: the confirm; without it nothing is written
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
  --no-scan              audit: do not scan for unledgered markers`;

export const CLI_SPEC = {
  prog: 'canary-unquarantine',
  booleans: {
    '--json': 'json',
    '--strict': 'strict',
    '--no-scan': 'noScan',
    '--include-abstained': 'includeAbstained',
    '--yes': 'yes',
    '--apply': 'apply',
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
  },
  defaults: { repo: '.' },
  positionals: { key: 'command', defaults: ['audit'] },
};
