/**
 * vitest `--reporter=json` -> a v2 history run (#538).
 *
 * Moved out of `run-recorder.ts` (#969) so each report format is one reader in
 * `formats/`, beside `playwright-report.ts`. vitest has no flaky status, so a
 * retried-then-passed test arrives as `passed` and `flaky` is always 0; the
 * command says so out loud (see `run-recorder.ts`).
 *
 * Validation is the caller's job (`../run-recorder.ts` `validateBuiltRun`);
 * this module only imports the schema so the two files cannot form a cycle.
 */
import {
  makeRunId,
  type RecordContext,
  type RunInput,
  type TestResultInput,
} from '../schema.js';

interface VitestAssertion {
  fullName?: string;
  title?: string;
  status?: string;
  duration?: number;
  failureMessages?: unknown[];
}

interface VitestFile {
  name?: string;
  status?: string;
  message?: string;
  assertionResults?: VitestAssertion[];
}

interface VitestReport {
  startTime?: number;
  testResults?: VitestFile[];
}

/** A top-level `testResults` array. Checked before the Playwright shape. */
export function isVitestReport(parsed: object): boolean {
  return Array.isArray((parsed as VitestReport).testResults);
}

/** Per-test result count, before any run-level fact is resolved. */
export function countVitestResults(parsed: unknown): number {
  const files = (parsed as VitestReport).testResults ?? [];
  return files.reduce((n, f) => n + (f.assertionResults?.length ?? 0), 0);
}

/** vitest status -> canary status. Anything not pass/fail is a skip. */
function toCanaryStatus(status: string | undefined): string {
  if (status === 'passed') return 'passed';
  if (status === 'failed') return 'failed';
  return 'skipped';
}

function toResultRow(
  assertion: VitestAssertion,
  file: VitestFile,
  ids: { runId: string; suite: string; repo: string },
): TestResultInput {
  const first = assertion.failureMessages?.[0];
  return {
    run_id: ids.runId,
    suite: ids.suite,
    repo: ids.repo,
    // No `(unnamed)` fallback: the test name is the join key every later query
    // groups on, so inventing one would merge unrelated tests into a single
    // history. A nameless row is a validation failure instead.
    test_name: assertion.fullName ?? assertion.title ?? '',
    test_file: file.name ?? '',
    status: toCanaryStatus(assertion.status),
    duration_ms: Math.round(assertion.duration ?? 0),
    ...(first === undefined
      ? {}
      : { error_text: String(first).slice(0, 2000) }),
  };
}

// #1351: vitest sets a file's `message` only for a failure outside any test (a
// load error, a file hook), so it becomes one failed row named after its file.
function fileRows(file: VitestFile): VitestAssertion[] {
  const tests = file.assertionResults ?? [];
  if (file.status !== 'failed' || !file.message) return tests;
  const fullName = `${file.name ?? ''} (file failed outside any test)`;
  const failureMessages = [file.message];
  return [...tests, { fullName, status: 'failed', failureMessages }];
}

/** Convert a parsed vitest JSON report into a run + its per-test rows. */
export function readVitestReport(
  parsed: unknown,
  ctx: RecordContext,
): { run: RunInput; results: TestResultInput[] } {
  const report = parsed as VitestReport;
  const startedMs =
    typeof report.startTime === 'number' ? report.startTime : ctx.nowMs;
  const epochSeconds = Math.floor(startedMs / 1000);
  const runId = ctx.runId ?? makeRunId(ctx.suite, ctx.commitSha, epochSeconds);

  const ids = { runId, suite: ctx.suite, repo: ctx.repo };
  const results: TestResultInput[] = [];
  for (const file of report.testResults ?? []) {
    for (const row of fileRows(file)) results.push(toResultRow(row, file, ids));
  }

  const count = (status: string): number =>
    results.filter((r) => r.status === status).length;

  const run: RunInput = {
    run_id: runId,
    suite: ctx.suite,
    repo: ctx.repo,
    branch: ctx.branch,
    commit_sha: ctx.commitSha,
    // The store's own timestamps use `+00:00` rather than `Z` (Python
    // `datetime.isoformat()`), and `queryTimeline` sorts these as strings.
    timestamp: new Date(startedMs).toISOString().replace('Z', '+00:00'),
    total: results.length,
    passed: count('passed'),
    failed: count('failed'),
    // vitest has no flaky status to read.
    flaky: 0,
    skipped: count('skipped'),
    duration_ms: results.reduce((n, r) => n + (r.duration_ms ?? 0), 0),
  };
  return { run, results };
}
