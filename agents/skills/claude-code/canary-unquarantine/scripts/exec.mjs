// exec -- the command runner and the two ways its answers are read.
//
// Every tracker call goes through an injected runner with this shape, so tests
// can drive `gh`, `git` and `curl` with no network.

import { spawnSync } from 'node:child_process';

/** Default runner: a synchronous spawn, never through a shell. */
export function spawnRunner(cmd, args, { input, cwd } = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    input,
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    error: r.error ? r.error.message : '',
  };
}

const firstLine = (s) =>
  String(s ?? '')
    .trim()
    .split('\n')[0];

export function failure(r, what) {
  if (r.error) return `${what}: ${r.error}`;
  return `${what} exited ${r.status}: ${firstLine(r.stderr) || firstLine(r.stdout) || 'no output'}`;
}

/** Parse a `gh` JSON answer, or explain why it could not be. */
export function parseJson(r, what) {
  if (r.status !== 0) return { why: failure(r, what) };
  try {
    return { value: JSON.parse(r.stdout) };
  } catch (exc) {
    return { why: `${what} returned unparseable JSON: ${exc.message}` };
  }
}
