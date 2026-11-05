/**
 * The runner half of `canary rewind` (#461 PR 2): the command that reruns one
 * recorded test, and reading that test's status back out of the runner's own
 * JSON report.
 *
 * The status is read with the same readers `history record` uses, so the name
 * a replay looks for is built the way the stored name was, before `record` made
 * a synthetic row's path repo-relative (see `syntheticStatus`).
 */

import { isAbsolute, resolve } from 'node:path';

import { buildRunFromPlaywrightReport } from '../../history/formats/playwright-report.js';
import { readVitestReport } from '../../history/formats/vitest-report.js';
import { FILE_FAILURE_SUFFIX } from '../../history/schema.js';

export type ReplayRunner = 'vitest' | 'playwright';

export interface ReplaySpec {
  runner: ReplayRunner;
  /** The failed test's file, relative to the directory the command runs in. */
  file: string;
  testName: string;
  seed: string | null;
  /** Files that started before the failed test's file, in start order. */
  predecessors: string[];
  reportPath: string;
}

export interface ReplayCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** The recorded seed was passed to the runner. */
  seedApplied: boolean;
}

const escapeRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function replayCommand(spec: ReplaySpec): ReplayCommand {
  return spec.runner === 'vitest'
    ? vitestCommand(spec)
    : playwrightCommand(spec);
}

function vitestCommand(spec: ReplaySpec): ReplayCommand {
  const args = [
    'vitest',
    'run',
    ...spec.predecessors,
    spec.file,
    '--reporter=json',
    `--outputFile=${spec.reportPath}`,
  ];
  // No name filter: vitest matches `-t` against `describe > it`, while its
  // JSON report (and so the stored name) joins with spaces, so a pattern built
  // from the stored name can silently match nothing and skip every test. The
  // whole file runs and the target's status is read from the report.
  if (spec.predecessors.length > 0) args.push('--no-file-parallelism');
  if (spec.seed !== null) args.push(`--sequence.seed=${spec.seed}`);
  return { command: 'npx', args, env: {}, seedApplied: spec.seed !== null };
}

/** `a > b [project]` -> the last title and the project, when present. */
function splitPlaywrightName(name: string): {
  title: string;
  project?: string;
} {
  const match = /^(.*) \[([^\]]+)\]$/.exec(name);
  const path = match ? match[1]! : name;
  const title = path.split(' > ').pop() ?? path;
  return match ? { title, project: match[2]! } : { title };
}

function playwrightCommand(spec: ReplaySpec): ReplayCommand {
  const { title, project } = splitPlaywrightName(spec.testName);
  const args = [
    'playwright',
    'test',
    ...spec.predecessors,
    spec.file,
    '--reporter=json',
  ];
  if (project !== undefined) args.push('--project', project);
  if (spec.predecessors.length > 0) args.push('--workers=1');
  // A synthetic row names no test, so a grep would select nothing: the runner
  // then reports `No tests found` for a clean file, hiding that it loaded.
  else if (syntheticTail(spec.testName) === null) {
    args.push('--grep', escapeRegex(title));
  }
  // Playwright has no seed option, so a recorded seed is never claimed.
  return {
    command: 'npx',
    args,
    env: { PLAYWRIGHT_JSON_OUTPUT_NAME: spec.reportPath },
    seedApplied: false,
  };
}

const CTX = {
  suite: 'rewind',
  repo: 'rewind',
  branch: 'rewind',
  commitSha: 'rewind',
  nowMs: 0,
};

/** The stored test a report is read for, and where this replay checked it out. */
export interface ReplayTarget {
  testName: string;
  /** The stored, repo-relative `test_file`. */
  file: string;
  /** The real path of the replay's checkout: runners report real paths. */
  root: string;
}

/** The replayed test's canary status, or null if the report cannot say. */
export function readReplayStatus(
  runner: ReplayRunner,
  reportText: string,
  target: ReplayTarget,
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reportText);
  } catch {
    return null;
  }
  const { results } =
    runner === 'vitest'
      ? readVitestReport(parsed, CTX)
      : buildRunFromPlaywrightReport(parsed, CTX);
  const tail = syntheticTail(target.testName);
  if (tail !== null && namesFile(target, tail)) {
    return syntheticStatus(runner, parsed, results, target, tail);
  }
  return results.find((r) => r.test_name === target.testName)?.status ?? null;
}

/** What follows a synthetic name's path: the suffix and any ` #2`, else null. */
function syntheticTail(name: string): string | null {
  const at = name.indexOf(FILE_FAILURE_SUFFIX);
  if (at === -1) return null;
  const tail = name.slice(at);
  return /^( #\d+)?$/.test(tail.slice(FILE_FAILURE_SUFFIX.length))
    ? tail
    : null;
}

/**
 * A real test may be titled like a synthetic row; this one's path must be the
 * stored file, repo-relative or (stored before #1411) the end of an absolute path.
 */
function namesFile(target: ReplayTarget, tail: string): boolean {
  const path = target.testName.slice(0, -tail.length);
  return path === target.file || path.endsWith(`/${target.file}`);
}

/**
 * A synthetic row exists only when its file fails (#1411), so a clean attempt has
 * no row to find and "absent" must count as `passed`, or a repeat count could
 * never say `intermittent`. That holds only for a file the report proves ran:
 * anything else abstains. The row is matched at the exact path under the replay
 * root, because a runner's file argument is a filter that also selects
 * `sub/<file>`, and that file's failure says nothing about this one.
 */
function syntheticStatus(
  runner: ReplayRunner,
  parsed: unknown,
  results: { test_name: string; test_file: string; status: string }[],
  target: ReplayTarget,
  tail: string,
): string | null {
  const expected = resolve(target.root, target.file);
  const row = results.find(
    (r) =>
      isAbsolute(r.test_file) &&
      resolve(r.test_file) === expected &&
      r.test_name === `${r.test_file}${tail}`,
  );
  if (row) return row.status;
  return reportedFiles(runner, parsed).includes(expected) ? 'passed' : null;
}

/** The absolute paths of the files a report says ran. */
function reportedFiles(runner: ReplayRunner, parsed: unknown): string[] {
  if (runner === 'vitest') {
    const { testResults } = parsed as { testResults?: { name?: unknown }[] };
    return strings((testResults ?? []).map((f) => f.name));
  }
  // Playwright lists a file relative to its rootDir, and only if the run loaded.
  const { config, suites } = parsed as {
    config?: { rootDir?: unknown };
    suites?: { file?: unknown }[];
  };
  const rootDir = config?.rootDir;
  if (typeof rootDir !== 'string') return [];
  return strings((suites ?? []).map((s) => s.file)).map((f) =>
    resolve(rootDir, f),
  );
}

const strings = (values: unknown[]): string[] =>
  values.filter((v): v is string => typeof v === 'string');
