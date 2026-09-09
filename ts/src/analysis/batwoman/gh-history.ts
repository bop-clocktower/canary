/**
 * `RunHistoryPort` over the `gh` CLI (spec Phase 3, criterion 4).
 *
 * This is batwoman's only outward call, and therefore the only place where
 * "I could not find out" can be mistaken for "it did not happen". Every
 * failure path here is loud: a missing `gh`, a non-zero exit, and output that
 * will not parse all throw, because the registry turns a throw into `abstain`
 * and an abstention is the honest report. The one thing this module must never
 * do is return an empty history for a question it failed to ask -- that would
 * read downstream as "this workflow has never run", which is the false green
 * batwoman was built to catch.
 *
 * The subprocess is injected through the same {@link SubprocessRun} seam
 * `ticket-updater.ts` uses, so tests never shell out.
 */
import {
  defaultSubprocess,
  type SubprocessRun,
} from '../../core/workflow-discovery.js';
import type { RunHistory, RunHistoryPort, WorkflowRun } from './verdict.js';

/**
 * How many runs to request per workflow.
 *
 * Explicit on purpose. `gh run list` defaults to 20 (the spec says 30; the CLI
 * says otherwise) and reports nothing about the window it used, so a repo with
 * a busy workflow would answer from a window of days and say so nowhere.
 * Naming the number here makes the window a stated fact, and a page that fills
 * to exactly this many rows is what {@link RunHistory.complete} reports as
 * truncated.
 */
export const GH_RUN_LIMIT = 100;

/** How long to wait on one `gh` call, in seconds. */
const GH_TIMEOUT_SECONDS = 30;

/** One row of `gh run list --json createdAt,conclusion`. */
interface GhRunRow {
  createdAt?: unknown;
  conclusion?: unknown;
}

/**
 * One row to a {@link WorkflowRun}, or null when it cannot be placed in time.
 *
 * A row with no usable `createdAt` is dropped rather than defaulted: a run
 * with a guessed timestamp could land on either side of the merge and decide
 * the verdict. Dropping the row loses one piece of evidence; keeping it with
 * an invented date would manufacture one.
 */
function toRun(row: GhRunRow): WorkflowRun | null {
  if (typeof row.createdAt !== 'string') return null;
  const createdAt = new Date(row.createdAt);
  if (Number.isNaN(createdAt.getTime())) return null;
  return {
    createdAt,
    conclusion: typeof row.conclusion === 'string' ? row.conclusion : null,
  };
}

/** The argv for one workflow's history. Kept in one place so tests can pin it. */
function ghArgs(repo: string, workflowPath: string): string[] {
  return [
    'gh',
    'run',
    'list',
    '--repo',
    repo,
    '--workflow',
    workflowPath,
    '--limit',
    String(GH_RUN_LIMIT),
    '--json',
    'createdAt,conclusion',
  ];
}

/**
 * A `RunHistoryPort` that reads real run history through `gh`.
 *
 * @param repo `owner/name`, passed explicitly so the port does not depend on
 *   the process's working directory.
 * @param subprocess injected for tests; defaults to the shared `spawnSync`
 *   runner.
 */
export function ghRunHistory(
  repo: string,
  subprocess: SubprocessRun = defaultSubprocess,
): RunHistoryPort {
  return {
    // `async` so that a synchronous failure below -- a missing `gh` throws
    // straight out of spawnSync -- reaches the caller as a REJECTED promise
    // rather than as a throw during port construction. The registry catches
    // rejections to record an abstention; a synchronous throw would escape it.
    async runsForWorkflow(workflowPath: string): Promise<RunHistory> {
      return fetchHistory(repo, workflowPath, subprocess);
    },
  };
}

function fetchHistory(
  repo: string,
  workflowPath: string,
  subprocess: SubprocessRun,
): RunHistory {
  // A throwing runner (a missing `gh` is the common one) is left to propagate
  // untouched: its message names the real cause, and the registry will record
  // the abstention with that message attached.
  const result = subprocess(ghArgs(repo, workflowPath), {
    timeout: GH_TIMEOUT_SECONDS,
  });

  if (result.returncode !== 0) {
    throw new Error(
      `gh run list failed for ${workflowPath} (exit ${result.returncode}): ` +
        `${result.stderr.trim() || 'no stderr'}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    // Deliberately not treated as "no runs". Unreadable output means the
    // question went unanswered, and an unanswered question is an abstention.
    throw new Error(
      `gh run list returned unparseable JSON for ${workflowPath}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `gh run list returned ${typeof parsed}, not a list, for ${workflowPath}`,
    );
  }

  const runs = parsed
    .map((row) => toRun((row ?? {}) as GhRunRow))
    .filter((run): run is WorkflowRun => run !== null);

  return {
    runs,
    // Measured against the ROWS gh returned, not against the runs that
    // survived parsing. A dropped malformed row still proves the page was
    // full, and counting the survivors instead would report a truncated
    // window as complete -- turning a dropped row into a false verdict.
    complete: parsed.length < GH_RUN_LIMIT,
  };
}
