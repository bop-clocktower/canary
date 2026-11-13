/**
 * The scratch workspace a rewind runs in (#461 PR 2): which directory the
 * runner starts from, installing the old commit's dependencies, the files that
 * ran before the failed one, and running the replay attempts.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { RunRecord, TestResultRecord } from '../../history/record.js';
import { testFileProblem } from './plan.js';

export type ExecFn = (
  command: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string> },
) => Promise<{ code: number; output: string }>;

export interface AttemptPlan {
  exec: ExecFn;
  command: { command: string; args: string[]; env: Record<string, string> };
  cwd: string;
  reportPath: string;
  attempts: number;
  /** The status a report gives, or null when it cannot say. */
  read(reportText: string): string | null;
}

/**
 * Run the command `attempts` times, each status read from a fresh report. An
 * attempt whose report cannot say is left out, not counted as either result.
 */
export async function runAttempts(plan: AttemptPlan): Promise<string[]> {
  const { command, reportPath } = plan;
  const statuses: string[] = [];
  for (let i = 0; i < plan.attempts; i++) {
    rmSync(reportPath, { force: true });
    await plan.exec(command.command, command.args, {
      cwd: plan.cwd,
      env: command.env,
    });
    const text = existsSync(reportPath)
      ? readFileSync(reportPath, 'utf-8')
      : '';
    const status = plan.read(text);
    if (status !== null) statuses.push(status);
  }
  return statuses;
}

/** The nearest directory holding a package.json, walking up to the tree root. */
export function packageDir(tree: string, file: string): string {
  let dir = dirname(join(tree, file));
  while (dir.startsWith(tree) && dir !== tree) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return tree;
}

const INSTALLERS: [string, string, string[]][] = [
  ['package-lock.json', 'npm', ['ci']],
  ['pnpm-lock.yaml', 'pnpm', ['install', '--frozen-lockfile']],
  ['yarn.lock', 'yarn', ['install', '--frozen-lockfile']],
];

/**
 * Install from the old commit's lockfile when `node_modules` is missing.
 * Returns why it failed, or null. A failure is an environment finding, not a
 * replay result (accepted risk in the proposal).
 */
export async function install(
  pkgDir: string,
  deps: { exec: ExecFn },
): Promise<string | null> {
  if (existsSync(join(pkgDir, 'node_modules'))) return null;
  const found = INSTALLERS.find(([lock]) => existsSync(join(pkgDir, lock)));
  if (found === undefined) return null;
  const [, command, args] = found;
  const result = await deps.exec(command, args, { cwd: pkgDir, env: {} });
  return result.code === 0
    ? null
    : `${command} ${args.join(' ')} exited ${result.code}`;
}

/**
 * Files that started before the failed test's file in the same run. Each is a
 * stored path that reaches the runner's argv, so it passes the same check as
 * the failed test's own file (#1566).
 */
export function predecessors(run: RunRecord, test: TestResultRecord): string[] {
  const own = test.start_index;
  if (own === undefined) return [];
  const earlier = new Map<string, number>();
  for (const t of run.tests ?? []) {
    const i = t.start_index;
    if (
      i !== undefined &&
      i < own &&
      t.test_file &&
      testFileProblem(t.test_file) === null
    ) {
      earlier.set(t.test_file, i);
    }
  }
  return [...earlier.entries()].sort((a, b) => a[1] - b[1]).map(([f]) => f);
}

/** Run git; trimmed stdout, or null on any failure. */
export function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** F6: one fetch of the SHA, then give up. Never falls back to an ancestor. */
export function reachable(top: string, sha: string): boolean {
  const present = (): boolean =>
    git(top, ['cat-file', '-e', `${sha}^{commit}`]) !== null;
  if (present()) return true;
  git(top, ['fetch', '--quiet', 'origin', sha]);
  return present();
}

/**
 * Argument-array spawn, no shell: the run's file and test name come from a
 * history file and must never be interpreted by one. Output is captured, not
 * streamed, so the report stays the only thing on stdout.
 */
export const spawnExec: ExecFn = (command, args, opts) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => (output += String(d)));
    child.stderr.on('data', (d) => (output += String(d)));
    child.on('error', (e) => resolve({ code: 127, output: e.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
