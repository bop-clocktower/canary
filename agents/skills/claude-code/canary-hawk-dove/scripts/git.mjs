// git -- the one place canary-hawk-dove runs git (#618).
//
// argv only, never a shell string. Revisions come from a gate's JSON, which
// this skill does not control, so each is validated (no leading `-`, which git
// would read as an option) and the path list ends with `--`. The call is
// bounded in time and output, and a diff over the path cap is reported as
// unknown rather than read in part: a partial list cannot vouch that a file
// is absent from it.

import { execFileSync } from 'node:child_process';

/** Paths read from one diff; a larger diff cannot vouch for anything. */
const MAX_CHANGED = 5000;

const REV = /^[0-9A-Za-z][0-9A-Za-z._/~^-]{0,199}$/;

const GIT_OPTS = {
  encoding: 'utf8',
  timeout: 10_000,
  maxBuffer: 16 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'ignore'],
};

/**
 * `git diff --name-only base head` as a Set, or why it is unknown.
 *
 * @param {string} repo
 * @param {string|null} base
 * @param {string|null} head
 * @returns {{files?: Set<string>, unknown?: string}}
 */
export function changedFiles(repo, base, head) {
  if (!base || !head) return { unknown: 'the run names no diff endpoints' };
  if (!REV.test(base) || !REV.test(head)) {
    return { unknown: 'the run names an invalid revision' };
  }
  let out;
  try {
    const argv = ['-C', repo, 'diff', '--name-only', '-z', base, head, '--'];
    out = execFileSync('git', argv, GIT_OPTS);
  } catch {
    return { unknown: 'git could not diff the run endpoints' };
  }
  const files = out.split('\0').filter(Boolean);
  if (files.length > MAX_CHANGED) {
    return { unknown: `more than ${MAX_CHANGED} changed paths (not read)` };
  }
  return { files: new Set(files) };
}
