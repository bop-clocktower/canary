/**
 * The replay context `record` captures (#461 PR 1, ADR 0030): what a later
 * `canary rewind` needs to rerun a failed test as it originally ran, and what
 * a runner's report cannot say on its own.
 *
 * The rule is the proposal's: **never silently approximate.** A fact the
 * recorder does not know is stored as `null` so the replay can list it as
 * `not-recorded`. In particular a seed is recorded only when `--seed` is
 * passed; none of the supported report formats carries one, and reading one
 * out of log text would be a guess stored as a fact.
 */

import type { ReplayContext } from './replay-record.js';
import type { BuiltRun, ReportShape } from '../run-recorder.js';
import type { TestResultInput } from '../schema.js';
import {
  keyTestFiles,
  type KeyedRun,
  type RepoProbe,
} from './test-file-key.js';

export { runGit, type KeyedRun } from './test-file-key.js';

type Env = Record<string, string | undefined>;
type CommitSource = ReplayContext['commit_source'];

/** The host facts, injected so tests do not depend on the machine they run on. */
export interface HostFacts {
  node: string;
  os: string;
  arch: string;
}

interface CaptureInput {
  seed?: string | undefined;
  shape: ReportShape;
  parsed: unknown;
  env: Env;
  commitSource: CommitSource;
}

/** The replay block for one run. Reads only the env names it lists. */
export function captureReplayContext(
  input: CaptureInput,
  host: HostFacts,
): ReplayContext {
  const seed = input.seed ? input.seed : null;
  return {
    seed,
    seed_source: seed === null ? null : 'flag',
    runner: { name: input.shape, version: runnerVersion(input) },
    node: host.node,
    os: host.os,
    arch: host.arch,
    ci: ciName(input.env),
    commit_source: input.commitSource,
  };
}

/** Only Playwright's JSON report names its own version. */
function runnerVersion(input: CaptureInput): string | null {
  if (input.shape !== 'playwright') return null;
  const version = (input.parsed as { config?: { version?: unknown } }).config
    ?.version;
  return typeof version === 'string' && version !== '' ? version : null;
}

function ciName(env: Env): ReplayContext['ci'] {
  if (env['GITHUB_ACTIONS'] === 'true') return 'github-actions';
  const ci = env['CI'];
  return ci && ci !== 'false' && ci !== '0' ? 'other' : null;
}

/**
 * The commit a run is recorded against, and where that value came from.
 *
 * `local` keeps a null source: it names no commit, so a replay must abstain on
 * it. A `local` that HEAD replaced (#1021) is attributed to HEAD.
 */
export function resolveCommit(
  flag: string | undefined,
  env: Env,
  probe: { git(args: string[]): string | null },
  note: (line: string) => void,
): { sha: string; source: CommitSource } {
  if (flag && flag !== 'local') return { sha: flag, source: 'flag' };
  const ciSha = env['GITHUB_SHA'];
  if (!flag && ciSha && ciSha !== 'local') {
    return { sha: ciSha, source: 'GITHUB_SHA' };
  }
  const head = probe.git(['rev-parse', '--verify', '-q', 'HEAD']);
  if (!head) return { sha: 'local', source: null };
  note(
    `note: refused commit_sha 'local' inside a git repository; recorded ` +
      `HEAD ${head} instead.`,
  );
  return { sha: head, source: 'HEAD' };
}

interface VitestFileStart {
  name?: string;
  startTime?: unknown;
}

interface PwNode {
  file?: string;
  suites?: PwNode[];
  specs?: { tests?: { results?: { startTime?: unknown }[] }[] }[];
}

type SeeStart = (file: string | undefined, ms: number) => void;

/** Earliest start (ms) per report file path, for the formats that carry it. */
function fileStarts(shape: ReportShape, parsed: unknown): Map<string, number> {
  const starts = new Map<string, number>();
  const see: SeeStart = (file, ms) => keepEarliest(starts, file, ms);
  if (shape === 'vitest') vitestStarts(parsed, see);
  if (shape === 'playwright') {
    const suites = (parsed as { suites?: PwNode[] }).suites ?? [];
    for (const s of suites) walkPlaywright(s, '', see);
  }
  return starts;
}

function keepEarliest(
  starts: Map<string, number>,
  file: string | undefined,
  ms: number,
): void {
  if (!file || !Number.isFinite(ms)) return;
  starts.set(file, Math.min(starts.get(file) ?? ms, ms));
}

function vitestStarts(parsed: unknown, see: SeeStart): void {
  const files = (parsed as { testResults?: VitestFileStart[] }).testResults;
  for (const f of files ?? []) {
    if (typeof f.startTime === 'number') see(f.name, f.startTime);
  }
}

function walkPlaywright(node: PwNode, parentFile: string, see: SeeStart): void {
  const file = node.file || parentFile;
  for (const child of node.suites ?? []) walkPlaywright(child, file, see);
  for (const ms of attemptStarts(node)) see(file, ms);
}

/** Every attempt start time (ms) in one suite's own specs. */
function attemptStarts(node: PwNode): number[] {
  const tests = (node.specs ?? []).flatMap((spec) => spec.tests ?? []);
  return tests
    .flatMap((test) => test.results ?? [])
    .map((attempt) => attempt.startTime)
    .filter((start): start is string => typeof start === 'string')
    .map((start) => Date.parse(start));
}

/**
 * Stamp each row with its file's start rank (0 = first file to start).
 *
 * Runs on the report's own paths, BEFORE they are made repo-relative, so the
 * lookup keys match. A report without start times gets no `start_index` at
 * all: absent reads as not-recorded, where an invented order would not.
 */
export function attachStartIndex<
  T extends Pick<TestResultInput, 'test_file' | 'start_index'>,
>(results: T[], shape: ReportShape, parsed: unknown): T[] {
  const starts = fileStarts(shape, parsed);
  if (starts.size === 0) return results;
  const ranked = [...starts.entries()].sort((a, b) => a[1] - b[1]);
  const rank = new Map(ranked.map(([file], i) => [file, i]));
  return results.map((r) => {
    const index = rank.get(r.test_file);
    return index === undefined ? r : { ...r, start_index: index };
  });
}

/**
 * Everything `record` adds to a converted run before it is stored: file start
 * order (on the report's own paths), repo-relative keys, and the replay block.
 */
export function prepareRecordedRun(
  built: BuiltRun,
  report: { shape: ReportShape; parsed: unknown },
  probe: RepoProbe & { env: Env },
  capture: { seed?: string | undefined; commitSource: CommitSource },
): KeyedRun {
  const { shape, parsed } = report;
  const ordered = {
    run: built.run,
    results: attachStartIndex(built.results, shape, parsed),
  };
  const keyed = keyTestFiles(ordered, shape, parsed, probe);
  const replay = captureReplayContext(
    { ...capture, shape, parsed, env: probe.env },
    { node: process.version, os: process.platform, arch: process.arch },
  );
  return { ...keyed, run: { ...keyed.run, replay } };
}
