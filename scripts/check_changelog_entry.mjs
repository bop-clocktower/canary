#!/usr/bin/env node
// Flags a user-facing PR that adds no line to CHANGELOG.md's [Unreleased]
// section (#1418).
//
// Every release found [Unreleased] missing most user-facing changes (v8.0.0:
// 21 of 35 PRs; v9.4.0: ~20 of ~31), and the gap stayed invisible until the
// release notes were rebuilt from PR bodies at cut time. This puts the gap on
// the PR that opens it.
//
// What counts as user-facing: a PR whose title is a Conventional Commit of
// type feat, fix or perf, or any type marked breaking with `!`. chore, docs,
// test, ci, refactor, style and build are exempt.
//
// What counts as an entry: at least one added, non-blank, non-heading line
// inside `## [Unreleased]`, located by parsing the section boundaries of the
// file at the PR head. No `#N` is required, because entries cite the issue
// rather than the PR, and matching on the PR number reports false misses.
//
// The opt-out is a line in the PR body, `Changelog: none — <reason>`. A label
// cannot carry a reason, and one with no reason is refused.
//
// Exit codes follow the repo's gate convention (#508, ADR 0009):
//   0 = entry added, PR type exempt, or opted out with a reason
//   1 = a user-facing PR adds no [Unreleased] line (a finding)
//   2 = usage error
//   3 = ABSTAINED: the title cannot be classified, git cannot list the diff
//       or read CHANGELOG.md, the diff lists 0 files, or the [Unreleased]
//       heading is missing. None of these is evidence an entry exists.
//
// `changelog-entry.yml` maps 1 to a green job with the `::warning`, because
// the check is advisory. Promoting it means dropping that mapping.
//
//   PR_TITLE=... PR_BODY=... node scripts/check_changelog_entry.mjs \
//     [--base HEAD^1] [--head HEAD]
//
// The defaults suit a `pull_request` checkout of the merge commit with
// `fetch-depth: 2`: HEAD^1 is the base tip, so the diff is exactly what the PR
// would land. Reads git only; needs no token. The verdict itself is pure and
// lives in scripts/lib/changelog-entry.mjs; this file reads git and renders.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { assess } from './lib/changelog-entry.mjs';
import { isMain } from './lib/is-main.mjs';

const USAGE =
  'usage: check_changelog_entry.mjs [--base REF] [--head REF]\n' +
  '  reads PR_TITLE and PR_BODY from the environment';

const HOW_TO =
  'Add a bullet under ## [Unreleased] in CHANGELOG.md (under ### Added, ' +
  '### Changed or ### Fixed) that cites the issue number, or opt out with a ' +
  'line in the PR body: Changelog: none — <reason>';

/** Escape a workflow-command message so untrusted text stays on one line. */
function escapeData(text) {
  return String(text)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

const FIX_STEP =
  'Fix: give the PR a Conventional Commit title (feat|fix|perf|chore|docs|test|ci|refactor|style|build), ' +
  'and check out the merge commit with fetch-depth: 2 so HEAD^1 exists.';

const RENDER = {
  ok: (r) => ({
    line: `changelog-entry: ok — ${r.added} line(s) added under [Unreleased] (${r.type} PR, ${r.checked} changed file(s) checked).`,
    exitCode: 0,
  }),
  exempt: (r) => ({
    line: `changelog-entry: exempt — ${r.reason}.`,
    exitCode: 0,
  }),
  'opted-out': (r) => ({
    line: `::notice title=CHANGELOG entry opted out::Changelog: none — ${escapeData(r.reason)}`,
    exitCode: 0,
  }),
  missing: (r) => ({
    line: `::warning title=CHANGELOG entry missing::${escapeData(`${r.reason} ${HOW_TO}`)}`,
    exitCode: 1,
  }),
  abstain: (r) => ({
    line: `::error title=CHANGELOG check abstained::${escapeData(`ABSTAINED: ${r.reason}. ${FIX_STEP}`)}`,
    exitCode: 3,
  }),
};

const SUMMARY = {
  ok: (r) => `${r.added} line(s) added under \`[Unreleased]\`.`,
  exempt: (r) => `Exempt: ${r.reason}.`,
  'opted-out': () => 'Opted out with a `Changelog: none` line in the PR body.',
  missing: (r) => `**Missing.** ${r.reason} ${HOW_TO}`,
  abstain: (r) => `**ABSTAINED:** ${r.reason}. ${FIX_STEP}`,
};

/**
 * Stdout lines, job-summary lines and exit code for a verdict.
 *
 * @param {{verdict: string, reason: string}} result
 */
export function render(result) {
  const { line, exitCode } = RENDER[result.verdict](result);
  const summary = ['### CHANGELOG entry', '', SUMMARY[result.verdict](result)];
  return { stdout: [line], summary, exitCode };
}

/** Run git, returning stdout or throwing with git's own message. */
function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(String(error.stderr ?? '').trim() || error.message);
  }
}

/** One git read, as a value or a recorded error. */
function attempt(errors, field, fn) {
  try {
    return fn();
  } catch (error) {
    errors[field] = error.message;
    return null;
  }
}

/** The three git reads the verdict needs. A failed read becomes null. */
function readGit({ base, head, cwd = process.cwd() }) {
  const errors = {};
  const changedFiles = attempt(errors, 'changedFiles', () =>
    git(['diff', '--name-only', base, head], cwd).split('\n').filter(Boolean),
  );
  const changelog = attempt(errors, 'changelog', () =>
    git(['show', `${head}:CHANGELOG.md`], cwd),
  );
  const diff = attempt(errors, 'diff', () =>
    git(
      [
        'diff',
        '--unified=0',
        '--no-color',
        '--no-ext-diff',
        base,
        head,
        '--',
        'CHANGELOG.md',
      ],
      cwd,
    ),
  );
  return { changedFiles, changelog, diff, errors };
}

/** The verdict for the CLI, including the wiring failure of an unset title. */
function verdictFor(values, env) {
  if (env.PR_TITLE === undefined)
    return {
      verdict: 'abstain',
      reason:
        'PR_TITLE is not set; the workflow must pass github.event.pull_request.title through env',
    };
  const read = () => readGit({ base: values.base, head: values.head });
  return assess({ title: env.PR_TITLE, body: env.PR_BODY, read });
}

function main(argv, env) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        base: { type: 'string', default: 'HEAD^1' },
        head: { type: 'string', default: 'HEAD' },
      },
    }));
  } catch {
    console.error(USAGE);
    return 2;
  }
  const out = render(verdictFor(values, env));
  console.log(out.stdout.join('\n'));
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${out.summary.join('\n')}\n`);
  return out.exitCode;
}

if (isMain(import.meta.url))
  process.exitCode = main(process.argv.slice(2), process.env);
