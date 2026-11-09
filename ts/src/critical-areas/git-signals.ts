/** Everything `canary critical-areas` asks git (#1529). All of it names HEAD. */
import { execFileSync, spawnSync } from 'node:child_process';

import { CHURN_WINDOW_DAYS } from './scoring.js';

export interface GitFacts {
  ok: true;
  top: string;
  head: string;
  tracked: string[];
  candidates: string[];
  /** `null` is unmeasured, never "no commits"; the reason says why (D9). */
  churn: Map<string, number> | null;
  churnAbsentReason: string | null;
}

type GitRead = GitFacts | { ok: false; reason: string };
type ChurnRead = Pick<GitFacts, 'churn' | 'churnAbsentReason'>;

const SOURCE = /\.(?:[cm]?[jt]sx?|py|php)$/;
const EXCLUDED_DIR =
  /(?:^|\/)(?:node_modules|vendor|third_party|dist|build|out|coverage|fixtures?|__fixtures__|__mocks__|__tests__|tests?|specs?|e2e)\//;
const EXCLUDED_FILE =
  /\.d\.[cm]?ts$|\.min\.js$|\.(?:test|spec)\.[^./]+$|(?:^|\/)test_[^/]+\.py$|_test\.py$|(?:^|\/)conftest\.py$|Test\.php$/;
const MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Git hooks export these, and each one outranks the working directory, so run
 * from a hook this command would read the hook's repository. `--root` decides.
 */
const REPOSITORY_LOCAL_ENV = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
]);

const gitEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !REPOSITORY_LOCAL_ENV.has(k)),
  );

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      env: gitEnv(),
      maxBuffer: MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/**
 * Asked with no working directory because a missing `cwd` also spawns ENOENT,
 * which would blame git for a mistyped `--root`.
 */
const gitIsMissing = (): boolean => {
  const { error } = spawnSync('git', ['--version'], {
    env: gitEnv(),
    stdio: 'ignore',
  });
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
};

const isCandidate = (path: string): boolean =>
  SOURCE.test(path) && !EXCLUDED_DIR.test(path) && !EXCLUDED_FILE.test(path);

const nulList = (text: string | null): string[] =>
  (text ?? '').split('\0').filter((p) => p !== '');

/**
 * One commit must read the same on any machine, so the two settings that change
 * this output are pinned: `log.showRoot=false` drops the root commit's files and
 * `log.showSignature=true` prints signature text among the timestamp and paths.
 */
const LOG_CONFIG = ['-c', 'log.showRoot=true', '-c', 'log.showSignature=false'];

/** The window's start as ISO, or `null` when `headTime` is not a time. */
function windowStartFrom(headTime: string): string | null {
  if (!/^\d+$/.test(headTime.trim())) return null;
  const since = Number(headTime) - CHURN_WINDOW_DAYS * 86_400;
  const start = new Date(since * 1000);
  return Number.isNaN(start.getTime()) ? null : start.toISOString();
}

function readLog(top: string, windowStart: string): string | null {
  // `--since` stops the walk at the first older commit, so one backdated commit
  // would hide everything behind it. The filter form walks the whole history.
  return git(top, [
    ...LOG_CONFIG,
    'log',
    `--since-as-filter=${windowStart}`,
    '--format=',
    '--name-only',
    '--no-renames',
    '-z',
    'HEAD',
  ]);
}

const LOG_FAILED: ChurnRead = {
  churn: null,
  churnAbsentReason: 'git log failed',
};

/** Commits per path in the window ending at HEAD's commit time (D8). */
function readChurn(top: string): ChurnRead {
  const headTime = git(top, [
    ...LOG_CONFIG,
    'show',
    '-s',
    '--format=%ct',
    'HEAD',
  ]);
  if (headTime === null) return LOG_FAILED;
  const windowStart = windowStartFrom(headTime);
  if (windowStart === null) {
    return {
      churn: null,
      churnAbsentReason: `HEAD's commit time could not be parsed`,
    };
  }
  const log = readLog(top, windowStart);
  if (log === null) return LOG_FAILED;
  const churn = new Map<string, number>();
  for (const path of nulList(log)) {
    const name = path.trim();
    if (name !== '') churn.set(name, (churn.get(name) ?? 0) + 1);
  }
  return { churn, churnAbsentReason: null };
}

const SHALLOW: ChurnRead = {
  churn: null,
  churnAbsentReason: 'shallow clone: every file reads as one commit',
};

export function readGitFacts(start: string): GitRead {
  const top = git(start, ['rev-parse', '--show-toplevel'])?.trim();
  if (top === undefined) {
    const reason = gitIsMissing()
      ? 'git was not found on PATH'
      : `${start} is not in a git repository`;
    return { ok: false, reason };
  }
  const head = git(top, [
    'rev-parse',
    '--verify',
    '-q',
    'HEAD^{commit}',
  ])?.trim();
  if (head === undefined) {
    return { ok: false, reason: `${top} has no commit` };
  }
  const shallow = git(top, ['rev-parse', '--is-shallow-repository'])?.trim();
  const tracked = nulList(
    git(top, ['ls-tree', '-r', '-z', '--name-only', 'HEAD']),
  );
  return {
    ok: true,
    top,
    head,
    tracked,
    candidates: tracked.filter(isCandidate),
    ...(shallow === 'true' ? SHALLOW : readChurn(top)),
  };
}
