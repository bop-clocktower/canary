/**
 * Turn a test runner's own report into a v2 history run (#538).
 *
 * `canary analyze` and `canary history` have always READ
 * `test-results/reports/history-v2.jsonl`; until this module nothing in the
 * product wrote it, so every consumer who wanted a flake report had to author
 * the NDJSON by hand. This is the conversion half of `canary history record`;
 * the CLI half lives in `cli.ts` and the append itself belongs to the store
 * (`AsyncHistoryStore.pushRun`, per ADR 0013).
 *
 * Two deliberate limits, both of them data-honesty calls rather than laziness:
 *
 *   - **vitest `--reporter=json` only.** The shape is detected rather than
 *     declared by flag, and an unrecognized shape is refused loudly. The
 *     alternative -- reading an unknown document and finding zero tests in it --
 *     is indistinguishable from a suite that genuinely ran nothing, which is
 *     exactly the denominator collapse #508 exists to make visible. Playwright
 *     JSON and JUnit XML are parsed elsewhere in the repo (canary-test-reporter,
 *     canary-savant) but by self-contained skill CLIs the engine cannot import.
 *   - **`flaky` is always 0.** Canary's status vocabulary is
 *     passed/failed/flaky/skipped; vitest has no flaky status, so a test that
 *     was retried and then passed arrives as `passed` and is invisible here.
 *     Recorded as zero and SAID OUT LOUD by the command, because a reader who
 *     takes `flaky: 0` for a clean fleet has been misled by the tool.
 */

import {
  makeRunId,
  serializeLocalRecord,
  type RunInput,
  type TestResultInput,
} from './schema.js';

/** Canary's per-test status vocabulary (the store's read side keys on these). */
export const RECORD_STATUSES = [
  'passed',
  'failed',
  'flaky',
  'skipped',
] as const;

/** Report formats `record` can convert. `unknown` is refused, never guessed. */
export type ReportShape = 'vitest' | 'unknown';

/** The run-level facts the report itself cannot carry (repo, branch, commit). */
export interface RecordContext {
  suite: string;
  repo: string;
  branch: string;
  commitSha: string;
  /** Explicit run id; defaults to `makeRunId(suite, commit, epochSeconds)`. */
  runId?: string;
  /** Fallback clock for a report with no `startTime` (injected in tests). */
  nowMs: number;
}

export interface BuiltRun {
  run: RunInput;
  results: TestResultInput[];
}

/**
 * A report that cannot be recorded without corrupting the store.
 *
 * Thrown BEFORE any append: `NdjsonHistoryStore.pushRun` writes one line and
 * every later report divides by it, so a malformed record is not a local
 * failure -- it silently degrades every future read of the file.
 */
export class RecordValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordValidationError';
  }
}

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

/** Detect by shape, not by flag -- callers should not have to know the format. */
export function detectReportShape(parsed: unknown): ReportShape {
  if (parsed === null || typeof parsed !== 'object') return 'unknown';
  const testResults = (parsed as VitestReport).testResults;
  return Array.isArray(testResults) ? 'vitest' : 'unknown';
}

/**
 * How many per-test results the report carries -- the DENOMINATOR, available
 * before any run-level fact is resolved.
 *
 * Separate from the conversion so `record` can abstain on an empty report
 * before it starts complaining about a missing `--repo`: there is nothing to
 * record either way, and the abstention is the finding worth reporting.
 */
export function countReportResults(parsed: unknown): number {
  const report = parsed as VitestReport;
  let n = 0;
  for (const file of report.testResults ?? []) {
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
export function buildRunFromVitestReport(
  parsed: unknown,
  ctx: RecordContext,
): BuiltRun {
  const report = parsed as VitestReport;
  const startedMs =
    typeof report.startTime === 'number' ? report.startTime : ctx.nowMs;
  const epochSeconds = Math.floor(startedMs / 1000);
  const runId = ctx.runId ?? makeRunId(ctx.suite, ctx.commitSha, epochSeconds);

  const results: TestResultInput[] = [];
  for (const file of report.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      results.push(
        toResultRow(assertion, file, {
          runId,
          suite: ctx.suite,
          repo: ctx.repo,
        }),
      );
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
    // See the module docstring: vitest has no flaky status to read.
    flaky: 0,
    skipped: count('skipped'),
    duration_ms: results.reduce((n, r) => n + (r.duration_ms ?? 0), 0),
  };

  const built = { run, results };
  validateBuiltRun(built);
  return built;
}

/**
 * Reject a run that would poison later reads, using the store's own serializer.
 *
 * Checked against `serializeLocalRecord` rather than against the input objects,
 * because that is the exact shape the file receives -- a field lost or nulled
 * during serialization is caught here rather than by whoever queries it next
 * month.
 */
export function validateBuiltRun(built: BuiltRun): void {
  const record = serializeLocalRecord(built.run, built.results);
  for (const key of ['run_id', 'suite', 'repo', 'branch', 'commit_sha']) {
    if (!record[key]) {
      throw new RecordValidationError(`run field '${key}' is empty`);
    }
  }

  const allowed = new Set<string>(RECORD_STATUSES);
  const rows = record['tests'] as Record<string, unknown>[];
  for (const [index, row] of rows.entries()) {
    if (!row['test_name']) {
      throw new RecordValidationError(
        `result ${index} has no test name; the store has no key to join it on`,
      );
    }
    if (!allowed.has(String(row['status']))) {
      throw new RecordValidationError(
        `result ${index} ('${String(row['test_name'])}') has status ` +
          `'${String(row['status'])}', which is outside ` +
          `${RECORD_STATUSES.join('|')}`,
      );
    }
  }

  const { total, passed, failed, flaky, skipped } = built.run;
  if (total !== rows.length) {
    throw new RecordValidationError(
      `run total ${total} disagrees with ${rows.length} recorded result(s)`,
    );
  }
  if (passed + failed + flaky + skipped !== total) {
    throw new RecordValidationError(
      `status counts (${passed}/${failed}/${flaky}/${skipped}) do not sum to ` +
        `the total of ${total}`,
    );
  }
}
