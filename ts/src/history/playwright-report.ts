/**
 * Playwright `json` reporter -> a v2 history run (#956).
 *
 * The walk and the status classification mirror canary-test-reporter's
 * `parse.mjs` (`classify`, suite-path naming), so two canary readers of one
 * report agree on what passed and what flaked. The skill CLI is self-contained
 * and cannot be imported by the engine, hence a second, engine-side reader.
 *
 * What this adds over that parser, because the store needs it:
 *   - a `[project]` suffix on the test name, so one spec run on two browsers
 *     keeps two histories instead of merging into one;
 *   - per-test `duration_ms` as the SUM of every attempt (retries cost the
 *     suite real time), and a run `duration_ms` from `stats.duration`, which is
 *     wall clock -- Playwright runs workers in parallel, so the sum of tests
 *     overstates it.
 *
 * Validation is the caller's job (`run-recorder.ts` `validateBuiltRun`); this
 * module only imports the schema so the two files cannot form an import cycle.
 */
import { makeRunId, type RunInput, type TestResultInput } from './schema.js';

interface PwAttempt {
  status?: string;
  duration?: number;
  error?: { message?: string };
  errors?: { message?: string }[];
}

interface PwLocation {
  file?: string;
}

interface PwTest {
  title?: string;
  status?: string;
  projectName?: string;
  location?: PwLocation;
  results?: PwAttempt[];
}

interface PwSpec {
  title?: string;
  file?: string;
  location?: PwLocation;
  tests?: PwTest[];
}

interface PwSuite {
  title?: string;
  file?: string;
  suites?: PwSuite[];
  specs?: PwSpec[];
}

interface PwReport {
  stats?: { duration?: unknown; startTime?: unknown };
  suites?: PwSuite[];
}

/** One test with the suite context its name and file are resolved from. */
interface PwEntry {
  test: PwTest;
  spec: PwSpec;
  suitePath: string[];
  suiteFile: string;
}

/** The run-level facts the report cannot carry (a subset of RecordContext). */
interface RunContext {
  suite: string;
  repo: string;
  branch: string;
  commitSha: string;
  runId?: string;
  nowMs: number;
}

const ERROR_TEXT_LIMIT = 2000;

/** A top-level `suites` array. The vitest check runs first in the caller. */
export function isPlaywrightReport(parsed: object): boolean {
  return Array.isArray((parsed as PwReport).suites);
}

function walkSuite(
  suite: PwSuite,
  parentPath: string[],
  parentFile: string,
  out: PwEntry[],
): void {
  const suitePath = suite.title ? [...parentPath, suite.title] : parentPath;
  const suiteFile = suite.file || parentFile;
  for (const child of suite.suites ?? []) {
    walkSuite(child, suitePath, suiteFile, out);
  }
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      out.push({ test, spec, suitePath, suiteFile });
    }
  }
}

function collectEntries(parsed: unknown): PwEntry[] {
  const out: PwEntry[] = [];
  for (const suite of (parsed as PwReport).suites ?? []) {
    walkSuite(suite, [], '', out);
  }
  return out;
}

export function countPlaywrightResults(parsed: unknown): number {
  return collectEntries(parsed).length;
}

function isPassing(status: string | undefined): boolean {
  return status === 'passed' || status === 'expected';
}

/**
 * Playwright status -> canary status, as `parse.mjs` `classify` does.
 * `timedOut`, `interrupted` and anything unrecognized count as a failure, and
 * any failure with a passing attempt is a flake.
 */
function classify(status: string | undefined, attempts: PwAttempt[]): string {
  if (status === 'skipped' || status === 'pending') return 'skipped';
  if (isPassing(status)) return 'passed';
  if (status === 'flaky') return 'flaky';
  return attempts.some((a) => isPassing(a.status)) ? 'flaky' : 'failed';
}

function testName(entry: PwEntry): string {
  const specTitle = entry.spec.title ?? '';
  const parts = [...entry.suitePath, specTitle];
  const title = entry.test.title;
  if (title && title !== specTitle) parts.push(title);
  const name = parts.filter((p) => p !== '').join(' > ');
  const project = entry.test.projectName;
  return project ? `${name} [${project}]` : name;
}

function testFile(entry: PwEntry): string {
  return (
    entry.spec.file ||
    entry.test.location?.file ||
    entry.spec.location?.file ||
    entry.suiteFile
  );
}

function errorText(attempts: PwAttempt[]): string | undefined {
  const last = attempts[attempts.length - 1];
  const message = last?.error?.message ?? last?.errors?.[0]?.message;
  return message === undefined
    ? undefined
    : String(message).slice(0, ERROR_TEXT_LIMIT);
}

function sumDurations(attempts: PwAttempt[]): number {
  let total = 0;
  for (const a of attempts) {
    if (typeof a.duration === 'number') total += a.duration;
  }
  return Math.round(total);
}

function toResultRow(
  entry: PwEntry,
  ids: { runId: string; suite: string; repo: string },
): TestResultInput {
  const attempts = entry.test.results ?? [];
  const status = classify(entry.test.status, attempts);
  const error = status === 'failed' ? errorText(attempts) : undefined;
  return {
    run_id: ids.runId,
    suite: ids.suite,
    repo: ids.repo,
    test_name: testName(entry),
    test_file: testFile(entry),
    status,
    duration_ms: sumDurations(attempts),
    ...(error === undefined ? {} : { error_text: error }),
  };
}

function startedMs(report: PwReport, nowMs: number): number {
  const raw = report.stats?.startTime;
  const ms = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(ms) ? ms : nowMs;
}

function runDuration(report: PwReport, results: TestResultInput[]): number {
  const raw = report.stats?.duration;
  // A non-positive wall clock on a report with tests is not a measurement.
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return Math.round(raw);
  }
  return results.reduce((n, r) => n + (r.duration_ms ?? 0), 0);
}

/** Convert a parsed Playwright JSON report into a run + its per-test rows. */
export function buildRunFromPlaywrightReport(
  parsed: unknown,
  ctx: RunContext,
): { run: RunInput; results: TestResultInput[] } {
  const report = parsed as PwReport;
  const started = startedMs(report, ctx.nowMs);
  const runId =
    ctx.runId ??
    makeRunId(ctx.suite, ctx.commitSha, Math.floor(started / 1000));
  const ids = { runId, suite: ctx.suite, repo: ctx.repo };
  const results = collectEntries(parsed).map((e) => toResultRow(e, ids));
  const count = (status: string): number =>
    results.filter((r) => r.status === status).length;

  const run: RunInput = {
    run_id: runId,
    suite: ctx.suite,
    repo: ctx.repo,
    branch: ctx.branch,
    commit_sha: ctx.commitSha,
    // `+00:00`, not `Z`: the store's timestamps sort as strings.
    timestamp: new Date(started).toISOString().replace('Z', '+00:00'),
    total: results.length,
    passed: count('passed'),
    failed: count('failed'),
    flaky: count('flaky'),
    skipped: count('skipped'),
    duration_ms: runDuration(report, results),
  };
  return { run, results };
}
