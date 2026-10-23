#!/usr/bin/env node
// canary-unquarantine -- the release half of quarantine.
//
// canary-katana writes the quarantine ledger; this reads it back and asks, for
// every row, whether the thing it waits on has been resolved. It never
// releases on ticket state alone: the `audit` command only classifies, and a
// release goes through a trial run of the suite's own CI.
//
// Advisory by default (exit 0). `--strict` exits 1 when something needs action
// (a candidate, a stale or unlinked row, an unledgered marker) and 3 when the
// audit abstained (zero rows read, or a row whose tracker could not be read)
// -- a real finding outranks an abstention, as in the rest of the family.
//
// Invoked via `canary skills run canary-unquarantine -- [options]`.

import fs from 'node:fs';
import path from 'node:path';

import {
  createParser,
  formatUsageError,
  EXIT_USAGE,
} from '../../../lib/parse-args.mjs';
import { isMain } from '../../../lib/is-main.mjs';
import * as ledger from '../../canary-katana/scripts/ledger.mjs';
import { audit } from './audit.mjs';
import { DEFAULT_TAGS } from './markers.mjs';
import { jsonPayload, renderText } from './report.mjs';
import {
  githubTracker,
  jiraTracker,
  resolveGithubRepo,
  spawnRunner,
} from './trackers.mjs';

const PREFIX = 'canary-unquarantine:';

const USAGE =
  'usage: canary-unquarantine [-h] [audit] [--repo PATH] [--ledger PATH]\n' +
  '                           [--company PATH] [--github-repo OWNER/NAME]\n' +
  '                           [--tags LIST] [--json] [--strict] [--no-scan]\n' +
  '\n' +
  'Audit every quarantined test: find the ticket it waits on (following\n' +
  'hand-offs from closed issues to the upstream ticket), and classify it as\n' +
  'candidate, blocked, stale, unlinked or abstained. Read-only.\n' +
  '\n' +
  'commands:\n' +
  '  audit                  classify every ledger row (the default)\n' +
  '\n' +
  'options:\n' +
  '  -h, --help             show this help message and exit\n' +
  '  --repo PATH            the test suite repository (default: .)\n' +
  '  --ledger PATH          ledger (default: <repo>/.canary/quarantine.json)\n' +
  '  --company PATH         company.json (default: <repo>/.canary/company.json)\n' +
  '  --github-repo OWNER/NAME\n' +
  '                         repository a bare #N refers to (default: the\n' +
  "                         repo's own GitHub remote, via gh)\n" +
  '  --tags LIST            comma-separated quarantine tags (default:\n' +
  `                         company.json quarantine_tags, else ${DEFAULT_TAGS.join(',')})\n` +
  '  --json                 emit machine-readable output\n' +
  '  --strict               exit 1 when something needs action, 3 when the\n' +
  '                         audit abstained\n' +
  '  --no-scan              do not scan the suite for unledgered markers';

export const CLI_SPEC = {
  prog: 'canary-unquarantine',
  booleans: { '--json': 'json', '--strict': 'strict', '--no-scan': 'noScan' },
  values: {
    '--repo': { key: 'repo' },
    '--ledger': { key: 'ledger' },
    '--company': { key: 'company' },
    '--github-repo': { key: 'githubRepo' },
    '--tags': { key: 'tags' },
  },
  defaults: { repo: '.' },
  positionals: { key: 'command', defaults: ['audit'] },
};

const COMMANDS = new Set(['audit']);

const parseArgs = createParser(CLI_SPEC);

/** company.json, or an empty config. A malformed file is an error, not a default. */
export function loadCompany(file) {
  if (!fs.existsSync(file))
    return { jiraProjects: [], tags: null, found: false };
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = (v) =>
    Array.isArray(v)
      ? v.map(String)
      : typeof v === 'string'
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
  const tags = list(doc.quarantine_tags);
  return {
    jiraProjects: list(doc.jira_projects),
    tags: tags.length ? tags : null,
    found: true,
  };
}

/**
 * @param {string[]} argv
 * @param {{run?: Function, env?: object}} [deps] injected by tests: the
 *   command runner behind `gh` and `curl`, and the environment.
 */
export function main(argv = [], deps = {}) {
  const { opts: args, positionals, help, error } = parseArgs(argv);
  if (help) {
    console.log(USAGE);
    return 0;
  }
  if (error) {
    console.error(formatUsageError(CLI_SPEC.prog, error));
    return EXIT_USAGE;
  }
  const [command, ...extra] = positionals;
  if (!COMMANDS.has(command) || extra.length) {
    console.error(
      formatUsageError(
        CLI_SPEC.prog,
        `unrecognized arguments: ${[command, ...extra].filter((c) => !COMMANDS.has(c)).join(' ')}`,
      ),
    );
    return EXIT_USAGE;
  }

  const run = deps.run ?? spawnRunner;
  const env = deps.env ?? process.env;
  const repo = args.repo;
  const ledgerPath =
    args.ledger ?? path.join(repo, '.canary', 'quarantine.json');
  const companyPath =
    args.company ?? path.join(repo, '.canary', 'company.json');

  let doc;
  let company;
  try {
    doc = ledger.load(ledgerPath);
    company = loadCompany(companyPath);
  } catch (exc) {
    console.error(`${PREFIX} ${exc.message}`);
    return 1;
  }
  const tags = args.tags
    ? args.tags
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : (company.tags ?? DEFAULT_TAGS);

  const github = githubTracker({
    run,
    defaultRepo: () =>
      resolveGithubRepo({ run, repo, explicit: args.githubRepo }),
  });
  const lookup = {
    github,
    jira: jiraTracker({ run, projects: company.jiraProjects, env }),
  };
  const result = audit({
    repo,
    rows: doc.entries,
    lookup,
    jiraProjects: company.jiraProjects,
    tags,
    scan: !args.noScan,
  });

  const shown = {
    ledger: ledgerPath,
    githubRepo: args.githubRepo ?? github.repo(),
  };
  if (args.json)
    console.log(JSON.stringify(jsonPayload(result, shown), null, 2));
  else console.log(renderText(result, shown));

  if (!args.strict) return 0;
  if (result.verdict.actionable > 0) return 1;
  return result.verdict.status === 'abstained' ? 3 : 0;
}

// `process.exitCode`, not `process.exit()`: a large `--json` payload must
// drain before the process ends (#791).
if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
