#!/usr/bin/env node
// canary-unquarantine -- the release half of quarantine.
//
// canary-katana writes the quarantine ledger; this reads it back and asks, for
// every row, whether the thing it waits on has been resolved. It never
// releases on ticket state alone:
//
//   audit    classify every row (read-only)
//   trial    after one explicit confirm (--yes), open ONE draft PR in the
//            suite that lifts every candidate's marker, so the suite's own CI
//            runs them live
//   verdict  read that PR's CI result per test; with --apply, rewrite the PR:
//            passes are released (ledger row dropped), failures re-quarantined
//            and their ticket told, flakes handed to canary-flake-hunter
//
// Advisory by default (exit 0). `--strict` exits 1 when something needs action
// and 3 when the command abstained (zero rows read, an unreadable tracker, a
// trial run with no per-test result) -- a real finding outranks an abstention,
// as in the rest of the family.
//
// Invoked via `canary skills run canary-unquarantine -- [command] [options]`.

import path from 'node:path';

import {
  createParser,
  formatUsageError,
  EXIT_USAGE,
} from '../../../lib/parse-args.mjs';
import { isMain } from '../../../lib/is-main.mjs';
import * as ledger from '../../canary-katana/scripts/ledger.mjs';
import { audit } from './audit.mjs';
import { loadCompany, tagsFor } from './config.mjs';
import {
  jsonPayload,
  renderText,
  renderTrialAbstained,
  renderTrialPlan,
  renderVerdict,
  verdictDoc,
} from './report.mjs';
import { downloadResults } from './results.mjs';
import { applyVerdict } from './settle.mjs';
import { spawnRunner } from './exec.mjs';
import { jiraCommenter, jiraTracker } from './jira.mjs';
import { githubTracker, resolveGithubRepo } from './trackers.mjs';
import { openTrial, planTrial, selectRows } from './trial.mjs';
import { CLI_SPEC, USAGE } from './usage.mjs';
import { loadTrial, planVerdict } from './verdict.mjs';

export { CLI_SPEC };

const PREFIX = 'canary-unquarantine:';

const parseArgs = createParser(CLI_SPEC);

const companyPath = (args) =>
  args.company ?? path.join(args.repo, '.canary', 'company.json');

/** Load the ledger and config, run the audit. Throws on a corrupt input. */
function runAudit(args, run, env) {
  const ledgerPath =
    args.ledger ?? path.join(args.repo, '.canary', 'quarantine.json');
  const doc = ledger.load(ledgerPath);
  const company = loadCompany(companyPath(args));
  const tags = tagsFor(args.tags, company);
  const explicit = args.githubRepo;
  const github = githubTracker({
    run,
    defaultRepo: () => resolveGithubRepo({ run, repo: args.repo, explicit }),
  });
  const lookup = {
    github,
    jira: jiraTracker({ run, projects: company.jiraProjects, env }),
  };
  const scan = !args.noScan;
  const result = audit({
    repo: args.repo,
    rows: doc.entries,
    lookup,
    jiraProjects: company.jiraProjects,
    tags,
    scan,
  });
  return { result, ledgerPath, tags, githubRepo: explicit ?? github.repo() };
}

const print = (args, doc, text) =>
  console.log(args.json ? JSON.stringify(doc, null, 2) : text());

function auditCommand(args, run, env) {
  const { result, ledgerPath, githubRepo } = runAudit(args, run, env);
  const shown = { ledger: ledgerPath, githubRepo };
  print(args, jsonPayload(result, shown), () => renderText(result, shown));
  if (!args.strict) return 0;
  if (result.verdict.actionable > 0) return 1;
  return result.verdict.status === 'abstained' ? 3 : 0;
}

/** The ledger as a path inside the repository, which `settle` rewrites on the trial branch. */
function ledgerInRepo(repo, ledgerPath) {
  const rel = path.relative(repo, ledgerPath);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  throw new Error(
    `trial needs the ledger inside the repository (got ${ledgerPath}): the verdict rewrites it on the trial branch`,
  );
}

/** Why a trial has nothing to lift -- an abstention, never "nothing to do". */
function nothingToTrial(args, plan, counts) {
  const hint = args.includeAbstained
    ? ''
    : '; --include-abstained trials those too';
  const why =
    plan.checked === 0
      ? 'zero ledger rows read'
      : `no candidate could be lifted (${counts.candidate} candidate(s), ${counts.abstain} abstained${hint})`;
  print(args, { ...plan, abstained: true, why }, () =>
    renderTrialAbstained(why, plan.refused),
  );
  return args.strict ? 3 : 0;
}

function trialCommand(args, run, env) {
  const { result, ledgerPath, tags } = runAudit(
    { ...args, noScan: true },
    run,
    env,
  );
  const rows = selectRows(result, { includeAbstained: args.includeAbstained });
  const { lifts, refused } = planTrial(args.repo, rows, tags);
  const plan = {
    command: 'trial',
    checked: result.denominator.rows_read,
    selected: rows.length,
    refused,
  };
  plan.lifts = lifts.map(({ test, file, markerLine, class: cls }) => ({
    test,
    file,
    markerLine,
    class: cls,
  }));
  if (!lifts.length) return nothingToTrial(args, plan, result.counts);
  if (!args.yes) {
    print(args, { ...plan, abstained: false, confirmed: false }, () =>
      renderTrialPlan(plan),
    );
    return 0;
  }
  const ledgerRel = ledgerInRepo(args.repo, ledgerPath);
  const { branch, prBase } = args;
  const opened = openTrial({
    repo: args.repo,
    rows: lifts,
    tags,
    run,
    branch,
    prBase,
    ledger: ledgerRel,
  });
  const next =
    'When its CI finishes: canary-unquarantine verdict --pr <N> --artifact <results artifact>';
  const text = () =>
    `Opened trial PR ${opened.url} lifting ${opened.lifted} test(s) on ${opened.branch}.\n${next}`;
  print(args, { ...plan, abstained: false, confirmed: true, ...opened }, text);
  return 0;
}

const NO_RESULTS =
  'no results: pass --results PATH or --artifact NAME (a per-test report; the run conclusion alone cannot say which test passed)';

/** Where the trial run's results are: --results, else the CI artifact. */
function resultsSource(args, run, trial) {
  if (args.results) return { source: args.results };
  if (!args.artifact) return { why: NO_RESULTS };
  const dl = downloadResults(run, {
    repo: args.repo,
    ...trial,
    artifact: args.artifact,
  });
  return dl.why ? dl : { source: dl.dir };
}

function verdictAbstained(args, why) {
  const text = () =>
    `\u{26A0} Abstained \u{2014} verified zero items; this is not a pass. ${why}.`;
  print(
    args,
    { command: 'verdict', pr: args.pr, checked: 0, abstained: true, why },
    text,
  );
  return args.strict ? 3 : 0;
}

function verdictCommand(args, run, env) {
  if (args.pr == null) {
    console.error(formatUsageError(CLI_SPEC.prog, 'verdict needs --pr N'));
    return EXIT_USAGE;
  }
  const trial = loadTrial(run, args.pr, args.repo);
  const where = resultsSource(args, run, trial);
  const plan = where.why
    ? { abstain: where.why }
    : planVerdict(trial, where.source);
  if (plan.abstain) return verdictAbstained(args, plan.abstain);
  const jiraComment = jiraCommenter({
    run,
    projects: loadCompany(companyPath(args)).jiraProjects,
    env,
  });
  const comments = args.apply
    ? applyVerdict({
        run,
        repo: args.repo,
        trial,
        judged: plan.judged,
        jiraComment,
      })
    : [];
  const doc = verdictDoc(args, plan, comments);
  print(args, doc, () => renderVerdict(doc));
  if (!args.strict) return 0;
  if (doc.tests.some((t) => t.outcome === 'fail' || t.outcome === 'flaky'))
    return 1;
  return doc.abstained ? 3 : 0;
}

const COMMANDS = {
  audit: auditCommand,
  trial: trialCommand,
  verdict: verdictCommand,
};

/** A usage error for argv, or null. */
function usageError(error, positionals) {
  if (error) return error;
  const [command, ...extra] = positionals;
  const known = Object.hasOwn(COMMANDS, command);
  if (known && !extra.length) return null;
  return `unrecognized arguments: ${(known ? extra : positionals).join(' ')}`;
}

/**
 * @param {string[]} argv
 * @param {{run?: Function, env?: object}} [deps] injected by tests: the
 *   command runner behind `git`, `gh` and `curl`, and the environment.
 */
export function main(argv = [], deps = {}) {
  const { opts: args, positionals, help, error } = parseArgs(argv);
  if (help) {
    console.log(USAGE);
    return 0;
  }
  const bad = usageError(error, positionals);
  if (bad) {
    console.error(formatUsageError(CLI_SPEC.prog, bad));
    return EXIT_USAGE;
  }
  try {
    return COMMANDS[positionals[0]](
      args,
      deps.run ?? spawnRunner,
      deps.env ?? process.env,
    );
  } catch (exc) {
    console.error(`${PREFIX} ${exc.message}`);
    return 1;
  }
}

// `process.exitCode`, not `process.exit()`: a large `--json` payload must
// drain before the process ends (#791).
if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
