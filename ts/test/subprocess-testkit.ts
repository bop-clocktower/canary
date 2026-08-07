/**
 * Shared subprocess-capture helper for CLI and script contract tests (#622).
 *
 * Three suites — `mcp-identity`, `roadmap-groom`, `roadmap-sync-wrapper` — had
 * each hand-rolled the same normalisation, and each had independently tripped
 * the `ts/test` cyclomatic threshold of 10 doing it. The duplication was the
 * smell; the threshold trip was the symptom.
 *
 * The cost came from two places, both avoidable:
 *
 * 1. `execFileSync` **throws** on a non-zero exit, so every call site needed a
 *    try/catch plus nullish defaults to turn a thrown error back into a result.
 *    `spawnSync` returns the same information without throwing, so the whole
 *    normalisation stops existing rather than moving somewhere else.
 * 2. The analyzer counts each `?` marker in an *inline* type literal as a
 *    branch (`.harness/learnings.md`), so the `as { status?: ...; stdout?:
 *    ...; stderr?: ... }` cast cost three branches before any `??` ran.
 *    `spawnSync` is typed, so there is no cast at all.
 *
 * Not named `*.test.ts`, so vitest's `test/*.test.ts` glob never collects it.
 * Its own tests live in `subprocess-testkit.test.ts`.
 */

import { spawnSync } from 'node:child_process';

import { def } from '../src/util/coalesce.js';

export interface CaptureResult {
  /** Child exit code, or `failureStatus` when the child left none. */
  status: number;
  stdout: string;
  stderr: string;
  /** stdout followed by stderr — what a terminal user would have seen. */
  output: string;
}

export interface CaptureOptions {
  /** Written to the child's stdin. */
  input?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Exit code to report when the child leaves none — a signal kill yields
   * `status: null`. Reporting 0 there would be a false green, so each call
   * site declares what an unknown failure means to it. Defaults to 1.
   */
  failureStatus?: number;
}

/**
 * Runs `file` with `args` and returns the outcome, including a non-zero exit.
 *
 * Throws only when the child could not be spawned at all (a missing binary,
 * a bad `cwd`). That is a bug in the test rather than a case under test, and
 * folding it into a status would let a typo'd path read as an ordinary failed
 * run — the abstention-reported-as-result shape this repo keeps closing.
 */
export function runCapture(
  file: string,
  args: string[],
  options: CaptureOptions = {},
): CaptureResult {
  const child = spawnSync(file, args, {
    input: options.input,
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf-8',
  });

  if (child.error) throw child.error;

  const stdout = def(child.stdout, '');
  const stderr = def(child.stderr, '');
  return {
    status: def(child.status, def(options.failureStatus, 1)),
    stdout,
    stderr,
    output: `${stdout}${stderr}`,
  };
}
