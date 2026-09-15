/**
 * Contract tests for `scripts/branch-prune.mjs` (#836, ADR 0022).
 *
 * ADR 0022 adopts a branch prune whose load-bearing clause is the unpushed-work
 * audit. The hazard it names: a branch whose upstream is `origin/main` hides its
 * own unpushed commits from `git status`, so classification must come from
 * `git cherry` (content absent from origin/main) plus `git ls-remote` (what the
 * remote actually holds) — never from tracking state.
 *
 * Every case runs the script as a subprocess against a real throwaway repo with
 * a bare "origin", so the contract under test is exit codes, the deletion set,
 * and which refs actually survive. PR state is injected with `--pr-states`, so
 * no test reaches GitHub.
 *
 * Exit codes follow the repo's gate convention (#508):
 *   0 = examined at least one prunable-kind branch
 *   2 = error (bad flag, unresolvable base)
 *   3 = ZERO DENOMINATOR — nothing but protected refs to examine
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCapture } from './subprocess-testkit.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'branch-prune.mjs');

interface Entry {
  branch: string;
  action: 'delete' | 'keep';
  reason: string;
}
interface Report {
  mode: string;
  local: Entry[];
  remote: Entry[];
  deleted: string[];
}

let root: string;
let work: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function commit(file: string, body: string): string {
  writeFileSync(join(work, file), body);
  git(work, 'add', file);
  git(work, 'commit', '-q', '-m', `add ${file}`);
  return git(work, 'rev-parse', 'HEAD');
}

/** A branch off main carrying one commit, pushed, main left untouched. */
function pushedBranch(name: string, file: string): string {
  git(work, 'switch', '-q', '-c', name, 'main');
  const sha = commit(file, `${name}\n`);
  git(work, 'push', '-q', 'origin', name);
  git(work, 'switch', '-q', 'main');
  return sha;
}

/** A branch whose commit lands on main by fast-forward: cherry-clean. */
function mergedBranch(name: string, file: string): void {
  pushedBranch(name, file);
  git(work, 'merge', '-q', '--ff-only', name);
  git(work, 'push', '-q', 'origin', 'main');
}

function run(args: string[], prs: object[] = []) {
  const prFile = join(root, 'prs.json');
  writeFileSync(prFile, JSON.stringify(prs));
  const res = runCapture(
    'node',
    [SCRIPT, '--repo', work, '--pr-states', prFile, '--json', ...args],
    { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
  );
  return res;
}

function report(args: string[] = [], prs: object[] = []): Report {
  const res = run(args, prs);
  expect(res.status, res.output).toBe(0);
  return JSON.parse(res.stdout) as Report;
}

function find(list: Entry[], branch: string): Entry {
  const hit = list.find((e) => e.branch === branch);
  if (!hit)
    throw new Error(`${branch} not classified: ${JSON.stringify(list)}`);
  return hit;
}

function localRefs(): string[] {
  return git(work, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')
    .split('\n')
    .filter(Boolean);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'branch-prune-'));
  const origin = join(root, 'origin.git');
  work = join(root, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, work]);
  git(work, 'config', 'user.email', 'fixture@example.invalid');
  git(work, 'config', 'user.name', 'fixture');
  git(work, 'switch', '-q', '-c', 'main');
  commit('README', 'root\n');
  git(work, 'push', '-q', '-u', 'origin', 'main');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('branch-prune: dry-run default', () => {
  it('reports candidates but deletes nothing without --apply-local', () => {
    mergedBranch('feat/done', 'a.txt');
    const out = report();
    expect(out.mode).toBe('dry-run');
    expect(find(out.local, 'feat/done').action).toBe('delete');
    expect(out.deleted).toEqual([]);
    expect(localRefs()).toContain('feat/done');
  });

  it('never deletes a remote branch, even with --apply-local', () => {
    mergedBranch('feat/done', 'a.txt');
    const out = report(['--apply-local']);
    expect(find(out.remote, 'feat/done').action).toBe('delete');
    expect(git(work, 'ls-remote', '--heads', 'origin', 'feat/done')).not.toBe(
      '',
    );
  });

  it('rejects any flag that would delete remotely', () => {
    const res = run(['--apply-remote']);
    expect(res.status).toBe(2);
  });
});

describe('branch-prune: permanent protect-list', () => {
  const PROTECTED = [
    'fix/mcp-tool-path-containment',
    'fix/migrator-workflow-symlink-escape',
    'release/9.9',
  ];

  it.each(PROTECTED)(
    'keeps %s even when fully merged, and --apply-local leaves it',
    (name) => {
      mergedBranch(name, 'p.txt');
      mergedBranch('feat/other', 'o.txt');
      const out = report(['--apply-local']);
      expect(find(out.local, name)).toMatchObject({ action: 'keep' });
      expect(find(out.local, name).reason).toMatch(/protected/);
      expect(find(out.remote, name).action).toBe('keep');
      expect(localRefs()).toContain(name);
    },
  );

  it('keeps main protected on both sides', () => {
    mergedBranch('feat/other', 'o.txt');
    const out = report();
    expect(find(out.local, 'main').reason).toMatch(/protected/);
    expect(find(out.remote, 'main').reason).toMatch(/protected/);
  });

  it('keeps a protected branch even when its PR is MERGED', () => {
    const sha = pushedBranch('fix/mcp-tool-path-containment', 'x.txt');
    pushedBranch('feat/other', 'o.txt');
    const out = report(
      [],
      [
        {
          headRefName: 'fix/mcp-tool-path-containment',
          state: 'MERGED',
          headRefOid: sha,
        },
      ],
    );
    expect(find(out.local, 'fix/mcp-tool-path-containment').action).toBe(
      'keep',
    );
  });
});

describe('branch-prune: cherry / ls-remote classification', () => {
  it('keeps a pushed branch with commits not on origin/main and no merged PR', () => {
    const sha = pushedBranch('feat/open', 'b.txt');
    const out = report(
      [],
      [{ headRefName: 'feat/open', state: 'OPEN', headRefOid: sha }],
    );
    expect(find(out.local, 'feat/open').action).toBe('keep');
    expect(find(out.remote, 'feat/open').action).toBe('keep');
    expect(find(out.remote, 'feat/open').reason).toMatch(/not on origin\/main/);
  });

  it('keeps a branch tracking origin/main that hides an unpushed commit', () => {
    git(work, 'switch', '-q', '-c', 'feat/hidden', '--track', 'origin/main');
    commit('h.txt', 'hidden\n');
    git(work, 'switch', '-q', 'main');
    mergedBranch('feat/other', 'o.txt');
    const out = report(['--apply-local']);
    expect(find(out.local, 'feat/hidden').action).toBe('keep');
    expect(localRefs()).toContain('feat/hidden');
  });

  it('keeps a local branch that is only local, even if cherry-clean would not apply', () => {
    git(work, 'switch', '-q', '-c', 'feat/local-only');
    commit('l.txt', 'l\n');
    git(work, 'switch', '-q', 'main');
    mergedBranch('feat/other', 'o.txt');
    const out = report();
    expect(find(out.local, 'feat/local-only').action).toBe('keep');
  });
});

describe('branch-prune: merged-PR exception', () => {
  it('deletes a squash-merged branch whose MERGED PR head matches the tip', () => {
    const sha = pushedBranch('feat/squashed', 's.txt');
    commit('s-different.txt', 'squash lands as different content\n');
    git(work, 'push', '-q', 'origin', 'main');
    const out = report(
      ['--apply-local'],
      [{ headRefName: 'feat/squashed', state: 'MERGED', headRefOid: sha }],
    );
    expect(find(out.local, 'feat/squashed').action).toBe('delete');
    expect(find(out.remote, 'feat/squashed').reason).toMatch(/MERGED/);
    expect(out.deleted).toEqual(['feat/squashed']);
    expect(localRefs()).not.toContain('feat/squashed');
  });

  it('keeps a MERGED-PR branch whose local tip moved past the PR head', () => {
    const sha = pushedBranch('feat/squashed', 's.txt');
    git(work, 'switch', '-q', 'feat/squashed');
    commit('after.txt', 'post-merge work\n');
    git(work, 'switch', '-q', 'main');
    const out = report(
      ['--apply-local'],
      [{ headRefName: 'feat/squashed', state: 'MERGED', headRefOid: sha }],
    );
    expect(find(out.local, 'feat/squashed').action).toBe('keep');
    expect(localRefs()).toContain('feat/squashed');
  });

  it('keeps unmerged work when PR state is CLOSED', () => {
    const sha = pushedBranch('feat/closed', 'c.txt');
    const out = report(
      [],
      [{ headRefName: 'feat/closed', state: 'CLOSED', headRefOid: sha }],
    );
    expect(find(out.remote, 'feat/closed').action).toBe('keep');
  });
});

describe('branch-prune: worktree branches are never touched', () => {
  it('keeps a merged branch checked out in another worktree', () => {
    mergedBranch('feat/in-tree', 'w.txt');
    git(work, 'worktree', 'add', '-q', join(root, 'wt'), 'feat/in-tree');
    const out = report(['--apply-local']);
    const entry = find(out.local, 'feat/in-tree');
    expect(entry.action).toBe('keep');
    expect(entry.reason).toMatch(/worktree/);
    expect(localRefs()).toContain('feat/in-tree');
  });

  it('never offers a worktree-checked-out branch for remote deletion either', () => {
    mergedBranch('feat/in-tree', 'w.txt');
    git(work, 'worktree', 'add', '-q', join(root, 'wt'), 'feat/in-tree');
    const out = report();
    const entry = find(out.remote, 'feat/in-tree');
    expect(entry.action).toBe('keep');
    expect(entry.reason).toMatch(/worktree/);
  });

  it('keeps worktree-agent-* branches by name', () => {
    mergedBranch('worktree-agent-abc123', 'z.txt');
    mergedBranch('feat/other', 'o.txt');
    const out = report(['--apply-local']);
    expect(find(out.local, 'worktree-agent-abc123').action).toBe('keep');
    expect(localRefs()).toContain('worktree-agent-abc123');
  });
});

describe('branch-prune: denominator', () => {
  it('abstains with exit 3 when only protected refs exist', () => {
    const res = run([]);
    expect(res.status, res.output).toBe(3);
  });

  it('errors with exit 2 when the base ref does not resolve', () => {
    mergedBranch('feat/done', 'a.txt');
    const res = run(['--base', 'no-such-base']);
    expect(res.status).toBe(2);
  });
});
