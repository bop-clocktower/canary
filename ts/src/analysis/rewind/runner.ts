/**
 * The runner half of `canary rewind` (#461 PR 2): the command that reruns one
 * recorded test, and reading that test's status back out of the runner's own
 * JSON report.
 *
 * The status is read with the same readers `history record` uses, so the name
 * a replay looks for is built exactly the way the stored name was.
 */

import { buildRunFromPlaywrightReport } from '../../history/formats/playwright-report.js';
import { readVitestReport } from '../../history/formats/vitest-report.js';

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
  else args.push('--grep', escapeRegex(title));
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

/** The replayed test's canary status, or null if the report does not hold it. */
export function readReplayStatus(
  runner: ReplayRunner,
  reportText: string,
  testName: string,
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
  return results.find((r) => r.test_name === testName)?.status ?? null;
}
