/**
 * Playwright's top-level `errors` -> failed history rows (#1411).
 *
 * A spec that fails to load aborts the whole run, leaving `suites` empty and
 * only this list to say so; a throwing globalTeardown leaves the tests intact,
 * so without these rows that run reads as clean. Failures inside a test (hooks,
 * late throws, worker fixtures) stay on that test and never appear here, so
 * these rows cannot double count against the test rows. All of that was read off
 * real Playwright 1.64.1 reports; see `test/history-record-file-errors.test.ts`.
 */
import { FILE_FAILURE_SUFFIX, type TestResultInput } from '../schema.js';

/** A failure outside any test. A thrown non-Error carries only `value`. */
interface PwTopLevelError {
  message?: string;
  value?: string;
  location?: { file?: string };
}

export const ERROR_TEXT_LIMIT = 2000;

/** Names a failure with no file: a webServer that never started, a timeout. */
const RUN_FAILURE_NAME = '(run failed outside any test)';

/**
 * Messages Playwright reports in `errors` that are not failures of their own.
 * `No tests found` is the empty denominator, an abstention, or the echo of a
 * load error. `Testing stopped early` restates test failures already counted.
 * The match is on text, so a reworded notice shows up as a failed row: a false
 * failure can be seen, where a dropped real one cannot.
 */
const RUNNER_NOTICES = [
  /^(Error: )?No tests found/,
  /^Testing stopped early after \d+ maximum allowed failures/,
];

const ANSI_COLOR = /\u001b\[[0-9;]*m/g;

/** Only an unlocated error can be a notice: Playwright's carry no location. */
function isRunnerNotice(error: PwTopLevelError): boolean {
  if (error.location?.file) return false;
  const text = (error.message ?? '').replace(ANSI_COLOR, '');
  return RUNNER_NOTICES.some((notice) => notice.test(text));
}

function isErrorObject(error: unknown): error is PwTopLevelError {
  return typeof error === 'object' && error !== null;
}

function topLevelErrors(parsed: unknown): PwTopLevelError[] {
  const errors = (parsed as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return [];
  return errors.filter(isErrorObject).filter((e) => !isRunnerNotice(e));
}

/** How many rows `errorRows` will build: part of the report's denominator. */
export function countTopLevelErrors(parsed: unknown): number {
  return topLevelErrors(parsed).length;
}

/**
 * One failed row per error. A repeat gets ` #2`: the name is the join key and
 * flake counters add one per row, so sharing it would count one history twice in
 * a run. Real reports repeat: a helper two specs import is reported once for each.
 */
export function errorRows(
  parsed: unknown,
  ids: { runId: string; suite: string; repo: string },
): TestResultInput[] {
  const seen = new Map<string, number>();
  return topLevelErrors(parsed).map((error) => {
    const file = error.location?.file ?? '';
    const name = file ? `${file}${FILE_FAILURE_SUFFIX}` : RUN_FAILURE_NAME;
    const nth = (seen.get(name) ?? 0) + 1;
    seen.set(name, nth);
    const text = error.message ?? error.value;
    return {
      run_id: ids.runId,
      suite: ids.suite,
      repo: ids.repo,
      test_name: nth === 1 ? name : `${name} #${nth}`,
      test_file: file,
      status: 'failed',
      duration_ms: 0,
      ...(text === undefined
        ? {}
        : { error_text: String(text).slice(0, ERROR_TEXT_LIMIT) }),
    };
  });
}
