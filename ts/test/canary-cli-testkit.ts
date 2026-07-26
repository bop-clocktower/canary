/**
 * Shared harness for the main `canary` CLI tests -- the ts analog of Typer's
 * `CliRunner`. Builds a `canary` command wired to capturing sinks + injectable
 * fake factories + an isolated env/cwd/home, invokes it via
 * `parseAsync(argv, { from: 'user' })`, and returns captured stdout/stderr plus
 * the business exit code (`CliExit`) or commander usage exit code
 * (`CommanderError`).
 *
 * Not named `*.test.ts` so vitest's `test/*.test.ts` glob never collects it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CommanderError } from 'commander';

import { CliExit } from '../src/cli-common.js';
import { createCanaryCommand } from '../src/cli.js';
import type { MainDeps } from '../src/main-deps.js';

// Env keys the CLI (and the modules it drives) read directly; cleared before
// each invocation so a host env never leaks into a test.
const CANARY_ENV_KEYS = [
  'CANARY_ENV',
  'CANARY_HISTORY_DB_URL',
  'ATLASSIAN_URL',
  'ATLASSIAN_USER',
  'ATLASSIAN_TOKEN',
  'GITHUB_TOKEN',
];

export interface InvokeOptions {
  deps?: Partial<MainDeps>;
  env?: Record<string, string | undefined>;
  cwd?: string;
}

export interface InvokeResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Invoke the main CLI with `args`, capturing output + the exit code. */
export async function invokeCanary(
  args: string[],
  opts: InvokeOptions = {},
): Promise<InvokeResult> {
  const { deps = {}, env = {}, cwd } = opts;

  const savedEnv: Record<string, string | undefined> = {};
  for (const k of CANARY_ENV_KEYS) {
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
  const fullDeps: Partial<MainDeps> = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    env: process.env,
    // Non-interactive default: keep every shown default (typer.prompt with an
    // empty submission). Tests override for specific input.
    prompt: (_text: string, def: string) => def,
    ...deps,
  };

  let code = 0;
  try {
    const cmd = createCanaryCommand(fullDeps);
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
  for (const k of CANARY_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

/** Create an isolated temp directory; returns its path. Caller removes it. */
export function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), 'canary-cli-'));
}

/** Recursively remove a temp directory (best-effort). */
export function rmTmp(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
