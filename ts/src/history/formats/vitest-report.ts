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
import { makeRunId, type RunInput, type TestResultInput } from '../schema.js';

interface VitestAssertion {
  fullName?: string;
  title?: string;
  status?: string;
  duration?: number;
  failureMessages?: unknown[];
}

interface VitestFile {
  name?: string;
  assertionResults?: VitestAssertion[];
}

interface VitestReport {
  startTime?: number;
  testResults?: VitestFile[];
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

/** A top-level `testResults` array. Checked before the Playwright shape. */
export function isVitestReport(parsed: object): boolean {
  return Array.isArray((parsed as VitestReport).testResults);
}

/** Per-test result count, before any run-level fact is resolved. */
export function countVitestResults(parsed: unknown): number {
  let n = 0;
  for (const file of (parsed as VitestReport).testResults ?? []) {
    n += file.assertionResults?.length ?? 0;
  }
  return n;
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

/** Convert a parsed vitest JSON report into a run + its per-test rows. */
export function readVitestReport(
  parsed: unknown,
  ctx: RunContext,
): { run: RunInput; results: TestResultInput[] } {
  const report = parsed as VitestReport;
  const startedMs =
    typeof report.startTime === 'number' ? report.startTime : ctx.nowMs;
  const epochSeconds = Math.floor(startedMs / 1000);
  const runId = ctx.runId ?? makeRunId(ctx.suite, ctx.commitSha, epochSeconds);

  const ids = { runId, suite: ctx.suite, repo: ctx.repo };
  const results: TestResultInput[] = [];
  for (const file of report.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      results.push(toResultRow(assertion, file, ids));
    }
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
