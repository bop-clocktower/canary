// git -- the filesystem and git plumbing `trial`, `verdict` and `quarantine` share.
//
// Every write happens in a throwaway `git worktree` under the OS temp
// directory, created and removed here, so the user's own checkout is never
// switched, stashed or dirtied. Commands go through the injected runner, so
// tests can pair real git with a fake `gh`. A settle uses `guardedRun`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyEdits } from './lift.mjs';

/** A command's stdout, or a thrown error naming the command and its first line of output. */
export function must(r, what) {
  if (r.status !== 0) {
    const first = (r.stderr || r.error || r.stdout || '').trim().split('\n')[0];
    throw new Error(`${what} failed (exit ${r.status}): ${first}`);
  }
  return r.stdout.trim();
}

/**
 * The real path of `p`, symlinks resolved. A path that does not exist yet is
 * resolved through its nearest existing ancestor, so a write to
 * `link/new.json` is judged by where `link` really points.
 */
function realish(p) {
  let rest = '';
  for (let cur = p; ;) {
    try {
      return path.join(fs.realpathSync(cur), rest);
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return p;
      rest = path.join(path.basename(cur), rest);
      cur = up;
    }
  }
}

/**
 * `file` as a repo-relative POSIX path, or why it is refused. The path is
 * resolved, symlinks included, and must land strictly inside `repo`: a
 * `--file ../x` or an absolute path elsewhere would otherwise be edited.
 *
 * @returns {{rel: string, abs: string} | {why: string}}
 */
export function insideRepo(repo, file) {
  const outside = { why: `--file ${file} is outside --repo ${repo}` };
  const root = path.resolve(repo);
  const abs = path.resolve(root, String(file ?? ''));
  const within = (base, p) => {
    const rel = path.relative(base, p);
    const up = rel === '..' || rel.startsWith(`..${path.sep}`);
    return rel && !up && !path.isAbsolute(rel) ? rel : null;
  };
  const rel = within(root, abs);
  if (!rel || !within(realish(root), realish(abs))) return outside;
  return { rel: rel.split(path.sep).join('/'), abs };
}

/** A fresh temp directory. */
export const scratchDir = (prefix) =>
  fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** `rel` under `root`. */
export const at = (root, rel) => path.join(root, rel);

export const readAt = (root, rel) => fs.readFileSync(at(root, rel), 'utf8');

export const writeAt = (root, rel, text) =>
  fs.writeFileSync(at(root, rel), text, 'utf8');

/**
 * Run `fn(work)` in a new worktree of `repo` at `commit` (`options` go before
 * the path: `-b <branch>`, `--detach`), and always remove the worktree after.
 */
export function withWorktree(run, repo, { options = [], commit }, fn) {
  const tmp = scratchDir('unquarantine-');
  const work = path.join(tmp, 'tree');
  try {
    must(
      run('git', ['-C', repo, 'worktree', 'add', ...options, work, commit]),
      'git worktree add',
    );
    return fn(work);
  } finally {
    run('git', ['-C', repo, 'worktree', 'remove', '--force', work]);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * The commit at the tip of `branch` on origin. The refspec is fully spelled, so
 * a tag of the same name cannot stand in and the name cannot read as an option,
 * and the tip lands in a ref of this process's own, so a concurrent fetch
 * cannot swap it the way it could FETCH_HEAD.
 */
export function fetchBranchTip(run, repo, branch) {
  const ref = `refs/canary-unquarantine/fetch-${process.pid}`;
  const refspec = `+refs/heads/${branch}:${ref}`;
  must(
    run('git', ['-C', repo, 'fetch', '--no-tags', 'origin', refspec]),
    'git fetch',
  );
  try {
    return must(
      run('git', ['-C', repo, 'rev-parse', '--verify', `${ref}^{commit}`]),
      'git rev-parse',
    );
  } finally {
    run('git', ['-C', repo, 'update-ref', '-d', ref]);
  }
}

/** Settings that would run a program, from the trial tree, during a settle. */
const QUIET = [
  'core.hooksPath=/dev/null', // every hook, including post-checkout and pre-push
  'core.fsmonitor=false',
  'commit.gpgsign=false', // the settle commit is unsigned; a person reviews it
  'submodule.recurse=false',
  'fetch.recurseSubmodules=false',
  'push.recurseSubmodules=no',
  'gc.auto=0', // gc.recentObjectsHook
  'maintenance.auto=false',
];

/** The configured filter drivers' names, read so each can be switched off. */
function filterNames(run, repo) {
  const r = run('git', [
    '-C',
    repo,
    'config',
    '--name-only',
    '--get-regexp',
    '^filter\\..*\\.(clean|smudge|process|required)$',
  ]);
  if (r.status === 1) return []; // none configured
  const names = must(r, 'git config filter.*').split('\n').filter(Boolean);
  return [...new Set(names.map((n) => n.slice(7, n.lastIndexOf('.'))))];
}

/** One driver off. Empty commands pass bytes through, so stored blobs stay as they are. */
function filterOff(name) {
  if (name.includes('='))
    throw new Error(
      `filter "${name}" cannot be switched off for the settle; refusing to settle`,
    );
  return ['clean=', 'smudge=', 'process=', 'required=false'].map(
    (k) => `filter.${name}.${k}`,
  );
}

/**
 * A runner whose every git call has this operator's programs switched off. The
 * settle works in a tree the PR's editor wrote, and a program run there, or one
 * that reads from there, runs on this machine with these credentials. `-c` wins
 * over every config file, includeIf ones too. A .gitattributes on the branch
 * picks which filter driver runs, so all of them go off; files are rebuilt from
 * stored blobs, so a pointer or a clean-filtered file goes back unchanged.
 */
export function guardedRun(run, repo) {
  const settings = [...QUIET, ...filterNames(run, repo).flatMap(filterOff)];
  const guard = settings.flatMap((s) => ['-c', s]);
  return (cmd, args, options) =>
    run(cmd, cmd === 'git' ? [...guard, ...args] : args, options);
}

/**
 * Apply each lift's edits to the files under `root` (all of one file's edits
 * together, so their line numbers agree). Returns the files written.
 */
export function writeLifts(root, lifts) {
  const byFile = new Map();
  for (const l of lifts)
    byFile.set(l.file, [...(byFile.get(l.file) ?? []), ...l.edits]);
  for (const [file, edits] of byFile) {
    writeAt(
      root,
      file,
      applyEdits(readAt(root, file).split('\n'), edits).join('\n'),
    );
  }
  return [...byFile.keys()];
}
