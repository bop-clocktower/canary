#!/usr/bin/env node
/**
 * Branch prune with an unpushed-work audit (#836, ADR 0022).
 *
 * Classifies every local branch and every remote branch as keep/delete using
 * `git cherry` against <remote>/<base> and the tips `git ls-remote` reports —
 * never `git status`, because a branch whose upstream is origin/main hides its
 * own unpushed commits from tracking state. Rules live in
 * scripts/lib/branch-classify.mjs.
 *
 * DRY-RUN BY DEFAULT. `--apply-local` deletes local candidates only. There is
 * deliberately no flag that deletes a remote branch: that is a push, and a
 * human act. Unknown flags exit 2 so a mistyped or wished-for flag is loud.
 * Worktree pruning is out of scope until #889 is understood (ADR 0022 §3).
 *
 * Usage:
 *   node scripts/branch-prune.mjs [--repo DIR] [--remote origin] [--base main]
 *     [--pr-states prs.json] [--json] [--apply-local]
 *
 * Without --pr-states, PR state comes from `gh pr list`; if that fails every
 * branch with unique commits is kept (the merged-PR exception is unavailable).
 *
 * Exit codes (#508): 0 examined, 2 error, 3 ABSTENTION — no non-protected
 * branch was examined (e.g. a shallow CI checkout with no remote refs).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { classifyBranch, isProtected } from './lib/branch-classify.mjs';

const FLAGS_WITH_VALUE = new Set([
  '--repo',
  '--remote',
  '--base',
  '--pr-states',
]);
const BOOLEAN_FLAGS = new Set(['--json', '--apply-local']);

function die(message) {
  process.stderr.write(`branch-prune: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { repo: process.cwd(), remote: 'origin', base: 'main' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (FLAGS_WITH_VALUE.has(flag) && argv[i + 1] !== undefined) {
      opts[camel(flag)] = argv[i + 1];
      i += 1;
    } else if (BOOLEAN_FLAGS.has(flag)) {
      opts[camel(flag)] = true;
    } else {
      die(
        `unknown or incomplete flag: ${flag} (remote deletion is never offered)`,
      );
    }
  }
  return opts;
}

function camel(flag) {
  return flag.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase());
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function tryGit(repo, args) {
  try {
    return git(repo, args);
  } catch {
    return null;
  }
}

function lines(text) {
  return text ? text.split('\n').filter(Boolean) : [];
}

function localBranches(repo) {
  const out = git(repo, [
    'for-each-ref',
    '--format=%(refname:short) %(objectname)',
    'refs/heads',
  ]);
  return lines(out).map((l) => l.split(' '));
}

function remoteBranches(repo, remote) {
  const out = git(repo, ['ls-remote', '--heads', remote]);
  return lines(out).map((l) => {
    const [sha, ref] = l.split('\t');
    return [ref.replace(/^refs\/heads\//, ''), sha];
  });
}

function worktreeBranches(repo) {
  const out = git(repo, ['worktree', 'list', '--porcelain']);
  return new Set(
    lines(out)
      .filter((l) => l.startsWith('branch refs/heads/'))
      .map((l) => l.slice('branch refs/heads/'.length)),
  );
}

function uniqueCommits(repo, baseRef, tip) {
  const out = tryGit(repo, ['cherry', baseRef, tip]);
  if (out === null) return null;
  return lines(out).filter((l) => l.startsWith('+')).length;
}

function loadPrs(opts) {
  try {
    const raw = opts.prStates
      ? readFileSync(opts.prStates, 'utf-8')
      : execFileSync(
          'gh',
          [
            'pr',
            'list',
            '--state',
            'all',
            '--limit',
            '1000',
            '--json',
            'headRefName,state,headRefOid',
          ],
          {
            cwd: opts.repo,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
    return { source: opts.prStates ? 'file' : 'gh', prs: JSON.parse(raw) };
  } catch (err) {
    process.stderr.write(
      `branch-prune: PR state unavailable, merged-PR exception disabled (${err.message})\n`,
    );
    return { source: 'unavailable', prs: [] };
  }
}

function groupPrs(prs) {
  const byName = new Map();
  for (const pr of prs) {
    byName.set(pr.headRefName, [...(byName.get(pr.headRefName) ?? []), pr]);
  }
  return byName;
}

function classifyAll(opts, baseRef, prsByName) {
  const remote = remoteBranches(opts.repo, opts.remote);
  const remoteTips = new Map(remote);
  const inWorktree = worktreeBranches(opts.repo);
  const facts =
    (kind) =>
    ([branch, tip]) =>
      classifyBranch({
        branch,
        kind,
        tip,
        remoteTip: remoteTips.get(branch) ?? null,
        unique: uniqueCommits(opts.repo, baseRef, tip),
        // Both sides: a remote branch another agent has checked out is live
        // work even when merged, so it is never offered for remote deletion.
        // Both sides: a remote branch another agent has checked out is live
        // work even when merged, so it is never offered for remote deletion.
        inWorktree: inWorktree.has(branch),
        prs: prsByName.get(branch) ?? [],
      });
  return {
    local: localBranches(opts.repo).map(facts('local')),
    remote: remote.map(facts('remote')),
  };
}

function applyLocal(repo, entries) {
  const deleted = [];
  for (const entry of entries) {
    if (entry.action !== 'delete' || isProtected(entry.branch)) continue;
    git(repo, ['branch', '-D', entry.branch]);
    deleted.push(entry.branch);
  }
  return deleted;
}

function renderText(report) {
  const rows = [];
  for (const side of ['local', 'remote']) {
    rows.push(`## ${side} (${report.mode})`);
    for (const e of report[side])
      rows.push(`${e.action.padEnd(6)} ${e.branch} — ${e.reason}`);
  }
  if (report.deleted.length > 0)
    rows.push(`deleted locally: ${report.deleted.join(', ')}`);
  return `${rows.join('\n')}\n`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const baseRef = `${opts.remote}/${opts.base}`;
  if (
    tryGit(opts.repo, [
      'rev-parse',
      '--verify',
      '--quiet',
      `${baseRef}^{commit}`,
    ]) === null
  ) {
    die(`base ref ${baseRef} does not resolve; fetch first`);
  }
  const { source, prs } = loadPrs(opts);
  const { local, remote } = classifyAll(opts, baseRef, groupPrs(prs));
  const deleted = opts.applyLocal ? applyLocal(opts.repo, local) : [];
  const mode = opts.applyLocal ? 'apply-local' : 'dry-run';
  const report = {
    mode,
    base: baseRef,
    prStates: source,
    local,
    remote,
    deleted,
  };
  process.stdout.write(
    opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderText(report),
  );
  const examined = [...local, ...remote].filter((e) => !isProtected(e.branch));
  if (examined.length === 0) {
    process.stderr.write(
      'branch-prune: ABSTAINED — no non-protected branch examined\n',
    );
    process.exit(3);
  }
}

main();
