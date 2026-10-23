// git -- the filesystem and git plumbing `trial` and `verdict` share.
//
// Every write happens in a throwaway `git worktree` under the OS temp
// directory, created and removed here, so the user's own checkout is never
// switched, stashed or dirtied. Commands go through the injected runner, so
// tests can pair real git with a fake `gh`.

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
