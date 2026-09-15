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
 *   - **vitest `--reporter=json` and Playwright `json` only** (Playwright since
 *     #956); each format's reader lives in `formats/` (#969). The shape is detected rather than
 *     declared by flag, and an unrecognized shape is refused loudly. The
 *     alternative -- reading an unknown document and finding zero tests in it --
 *     is indistinguishable from a suite that genuinely ran nothing, which is
 *     exactly the denominator collapse #508 exists to make visible. JUnit XML is
 *     parsed elsewhere in the repo (canary-savant) but by a self-contained skill
 *     CLI the engine cannot import; it is not supported here yet.
 *   - **vitest `flaky` is always 0.** Canary's status vocabulary is
 *     passed/failed/flaky/skipped; vitest has no flaky status, so a test that
 *     was retried and then passed arrives as `passed` and is invisible here.
 *     Recorded as zero and SAID OUT LOUD by the command, because a reader who
 *     takes `flaky: 0` for a clean fleet has been misled by the tool. Playwright
 *     does report flakes, and those are recorded as `flaky`.
 *
 * Both formats write per-test and per-run `duration_ms`, which is what
 * `canary ci-ready` scores `suite-runtime` from.
 */

import {
  serializeLocalRecord,
  type RunInput,
  type TestResultInput,
} from './schema.js';
import {
  buildRunFromPlaywrightReport,
  countPlaywrightResults,
  isPlaywrightReport,
} from './formats/playwright-report.js';
import {
  countVitestResults,
  isVitestReport,
  readVitestReport,
} from './formats/vitest-report.js';

/** Canary's per-test status vocabulary (the store's read side keys on these). */
const RECORD_STATUSES = ['passed', 'failed', 'flaky', 'skipped'] as const;

/** Report formats `record` can convert. `unknown` is refused, never guessed. */
export type ReportShape = 'vitest' | 'playwright' | 'unknown';

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

/** Detect by shape, not by flag -- callers should not have to know the format. */
export function detectReportShape(parsed: unknown): ReportShape {
  if (parsed === null || typeof parsed !== 'object') return 'unknown';
  if (isVitestReport(parsed)) return 'vitest';
  return isPlaywrightReport(parsed) ? 'playwright' : 'unknown';
}

/**
 * Convert a report of a known shape, then validate it before any append.
 * Callers refuse `unknown` first; passing it here is a programming error.
 */
export function buildRunFromReport(
  shape: ReportShape,
  parsed: unknown,
  ctx: RecordContext,
): BuiltRun {
  if (shape === 'vitest') return buildRunFromVitestReport(parsed, ctx);
  if (shape !== 'playwright') {
    throw new Error(`cannot build a run from a report of shape '${shape}'`);
  }
  const built = buildRunFromPlaywrightReport(parsed, ctx);
  validateBuiltRun(built);
  return built;
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
  if (detectReportShape(parsed) === 'playwright') {
    return countPlaywrightResults(parsed);
  }
  return countVitestResults(parsed);
}

/** Convert a parsed vitest JSON report into a validated run + its rows. */
export function buildRunFromVitestReport(
  parsed: unknown,
  ctx: RecordContext,
): BuiltRun {
  const built = readVitestReport(parsed, ctx);
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
