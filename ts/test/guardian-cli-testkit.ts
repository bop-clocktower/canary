/**
 * Shared harness for the guardian CLI tests -- the ts analog of Typer's
 * `CliRunner`. Builds a `guardian` command wired to capturing sinks + a fake
 * stdin + isolated env, invokes it via `parseAsync(argv, { from: 'user' })`, and
 * returns the captured stdout/stderr plus the business exit code (from a thrown
 * {@link CliExit}) or commander usage exit code (from a `CommanderError`).
 *
 * This file is a testkit, not a suite (no `*.test.ts` name) so vitest's shallow
 * `test/*.test.ts` glob never collects it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CommanderError } from 'commander';

import {
  CliExit,
  GuardianDeps,
  createGuardianCommand,
} from '../src/guardian/cli.js';

// Env keys the CLI reads directly (outside commander's own `.env()`), cleared
// before each invocation so a host CI env never leaks into a test.
const GUARDIAN_ENV_KEYS = [
  'GITHUB_REPOSITORY',
  'GITHUB_REF',
  // #369: CI/base-ref detection for the auto-resolved PR diff. Cleared so a
  // host CI runner never makes a local test take the ci-base branch.
  'GITHUB_ACTIONS',
  'CI',
  'GITHUB_BASE_REF',
  'GITHUB_EVENT_PATH',
  'GITHUB_TOKEN',
  'GITHUB_STEP_SUMMARY',
  'CANARY_GUARDIAN_AGENT',
  'CANARY_GUARDIAN_IS_FORK',
  'CANARY_HISTORY_DB_URL',
];

export interface InvokeOptions {
  input?: string;
  env?: Record<string, string | undefined>;
  deps?: Partial<GuardianDeps>;
  cwd?: string;
}

export interface InvokeResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Invoke the guardian CLI with `args`, capturing output + the exit code. */
export async function invokeGuardian(
  args: string[],
  opts: InvokeOptions = {},
): Promise<InvokeResult> {
  const { input = '', env = {}, deps = {}, cwd } = opts;

  const savedEnv: Record<string, string | undefined> = {};
  for (const k of GUARDIAN_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const savedCwd = process.cwd();
  if (cwd) process.chdir(cwd);

  const out: string[] = [];
  const err: string[] = [];
  const fullDeps: Partial<GuardianDeps> = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    readStdin: () => input,
    env: process.env,
    ...deps,
  };

  let code = 0;
  try {
    const cmd = createGuardianCommand(fullDeps);
    await cmd.parseAsync(args, { from: 'user' });
  } catch (e) {
    if (e instanceof CliExit) code = e.code;
    else if (e instanceof CommanderError) code = e.exitCode;
    else {
      restore(savedEnv, savedCwd, cwd);
      throw e;
    }
  }
  restore(savedEnv, savedCwd, cwd);

  return {
    code,
    stdout: out.join('\n') + (out.length ? '\n' : ''),
    stderr: err.join('\n') + (err.length ? '\n' : ''),
  };
}

function restore(
  savedEnv: Record<string, string | undefined>,
  savedCwd: string,
  cwd: string | undefined,
): void {
  if (cwd) process.chdir(savedCwd);
  for (const k of GUARDIAN_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

/** Create an isolated temp directory; returns its path. Caller removes it. */
export function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), 'guardian-cli-'));
}

/** Recursively remove a temp directory (best-effort). */
export function rmTmp(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
