/** Everything `canary critical-areas` asks git (#1529). All of it names HEAD. */
import { execFileSync } from 'node:child_process';

import { CHURN_WINDOW_DAYS } from './scoring.js';

export interface GitFacts {
  ok: true;
  top: string;
  head: string;
  tracked: string[];
  candidates: string[];
  /** `null` in a shallow clone, where every file reads as one commit (D9). */
  churn: Map<string, number> | null;
}

type GitRead = GitFacts | { ok: false; reason: string };

const SOURCE = /\.(?:[cm]?[jt]sx?|py|php)$/;
const EXCLUDED_DIR =
  /(?:^|\/)(?:node_modules|vendor|third_party|dist|build|out|coverage|fixtures?|__fixtures__|__mocks__|__tests__|tests?|specs?|e2e)\//;
const EXCLUDED_FILE =
  /\.d\.[cm]?ts$|\.min\.js$|\.(?:test|spec)\.[^./]+$|(?:^|\/)test_[^/]+\.py$|_test\.py$|(?:^|\/)conftest\.py$|Test\.php$/;
const MAX_BUFFER = 256 * 1024 * 1024;

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      maxBuffer: MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

const isCandidate = (path: string): boolean =>
  SOURCE.test(path) && !EXCLUDED_DIR.test(path) && !EXCLUDED_FILE.test(path);

const nulList = (text: string | null): string[] =>
  (text ?? '').split('\0').filter((p) => p !== '');

/** Commits per path in the window ending at HEAD's commit time (D8). */
function readChurn(top: string): Map<string, number> {
  const seconds = Number(git(top, ['show', '-s', '--format=%ct', 'HEAD']));
  const since = seconds - CHURN_WINDOW_DAYS * 86_400;
  const log = git(top, [
    'log',
    `--since=${new Date(since * 1000).toISOString()}`,
    '--format=',
    '--name-only',
    '--no-renames',
    '-z',
    'HEAD',
  ]);
  const churn = new Map<string, number>();
  for (const path of nulList(log)) {
    const name = path.trim();
    if (name !== '') churn.set(name, (churn.get(name) ?? 0) + 1);
  }
  return churn;
}

export function readGitFacts(start: string): GitRead {
  const top = git(start, ['rev-parse', '--show-toplevel'])?.trim();
  if (top === undefined) {
    return { ok: false, reason: `${start} is not in a git repository` };
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
    churn: shallow === 'true' ? null : readChurn(top),
  };
}
