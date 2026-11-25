// canary-cry checkpoints, --max-wall and --resume -- PURE (#608 P4; spec
// "Verdicts and convergence", "Failure modes"; SC18). No I/O and no imports:
// the caller reads and writes `runs/<run-id>/checkpoint.json`, owns the clock
// (injected here as a `() => ms` function), and maps `exit` to process exit.
//
// THE DOCUMENT (checkpoint.json), rewritten after every scenario:
//
//   { format: 'canary.cry-checkpoint/1', runId, manifestSha, total,
//     results: ScenarioResult[] }
//
//   - `total` is the matrix's scenario count, the `m` of `PARTIAL: n/m`.
//   - `results` holds convergence.mjs's ScenarioResult records
//     (`{id, verdict, fingerprints}`), one per completed id, in run order.
//     The completed ids ARE the results' ids: one list, so the two can never
//     disagree. They are also all convergence needs to pick the run back up.
//
// RESUME (`--resume <run-id> --confirm <sha>`): exit 2 for anything that is a
// usage error (a malformed or unknown run id, an unreadable checkpoint), exit
// 4 for a safety refusal (the manifest changed, or --confirm does not match
// it) -- the same split as P2's `run --live`.

/** @typedef {{id: string, verdict: string, fingerprints: string[]}} ScenarioResult */

export const CHECKPOINT_FORMAT = 'canary.cry-checkpoint/1';

const EXIT_USAGE = 2;
const EXIT_REFUSED = 4;

/** cli.mjs's run-id: `<UTC stamp>-<first 8 of the sha>`, nothing else. */
const RUN_ID = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;

/** @param {{runId: string, manifestSha: string, total: number}} run */
export function newCheckpoint({ runId, manifestSha, total }) {
  return { format: CHECKPOINT_FORMAT, runId, manifestSha, total, results: [] };
}

/** A new checkpoint with `result` recorded; a re-run id replaces its last. */
export function recordResult(checkpoint, result) {
  const kept = checkpoint.results.filter((r) => r.id !== result.id);
  return { ...checkpoint, results: [...kept, result] };
}

const DURATION = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;
const UNIT_MS = [3_600_000, 60_000, 1_000];

const malformed = (text) => ({
  ms: null,
  error: `--max-wall: malformed duration '${text}' (use e.g. 90s, 30m, 2h, 1h30m)`,
});

/**
 * `--max-wall`: hours, minutes, seconds in that order, each at most once,
 * integers only, total above zero. Malformed input is a usage error (exit
 * 2), returned rather than thrown so it can never surface as exit 1.
 * @returns {{ms: number, error: null} | {ms: null, error: string}}
 */
export function parseMaxWall(text) {
  const m = typeof text === 'string' ? DURATION.exec(text) : null;
  if (m === null) return malformed(text);
  const ms = UNIT_MS.reduce(
    (sum, unit, i) => sum + Number(m[i + 1] ?? 0) * unit,
    0,
  );
  if (!Number.isSafeInteger(ms) || ms <= 0) return malformed(text);
  return { ms, error: null };
}

/** The wall-clock deadline, or null when no --max-wall was given. */
export function deadlineAt(startMs, maxWallMs) {
  return maxWallMs === null ? null : startMs + maxWallMs;
}

/** Whether the injected clock has reached the deadline. */
export function wallExpired(deadline, clock) {
  return deadline !== null && clock() >= deadline;
}

/** The loud stop line, derived from the checkpoint so the two agree. */
export function partialLine(checkpoint) {
  const n = checkpoint.results.length;
  return `PARTIAL: ${n}/${checkpoint.total} — resume with --resume ${checkpoint.runId}`;
}

const refusal = (exit, reason) => ({
  exit,
  reason,
  remaining: [],
  results: [],
});

/** Why a loaded checkpoint cannot be resumed as `runId`, or null. */
function unusable(checkpoint, runId) {
  if (checkpoint?.format !== CHECKPOINT_FORMAT) {
    return `run ${runId}: checkpoint.json is not ${CHECKPOINT_FORMAT}`;
  }
  if (checkpoint.runId !== runId || !Array.isArray(checkpoint.results)) {
    return `run ${runId}: checkpoint.json belongs to another run or is damaged`;
  }
  return null;
}

/** The safety half: the approval must bind to what would run now. */
function shaRefusal(checkpoint, rebuiltSha, confirm) {
  if (confirm !== rebuiltSha) {
    return (
      `manifest-sha mismatch: confirmed ${confirm}, rebuilt ${rebuiltSha}. ` +
      'Re-run without --confirm and read the new manifest.'
    );
  }
  if (rebuiltSha !== checkpoint.manifestSha) {
    return (
      `manifest changed since run ${checkpoint.runId} started: ` +
      `was ${checkpoint.manifestSha}, rebuilt ${rebuiltSha}. Start a new run.`
    );
  }
  return null;
}

/**
 * Resume planning. `checkpoint` is the parsed checkpoint.json for `runId`, or
 * null when the caller found none (an unknown run id). `scenarioIds` are the
 * rebuilt matrix's ids, in order.
 * @returns {{exit: null, reason: null, remaining: string[],
 *   results: ScenarioResult[]} | {exit: 2 | 4, reason: string, remaining: [],
 *   results: []}} on success `results` seeds convergence's `decideRound`
 */
export function planResume({
  runId,
  checkpoint,
  rebuiltSha,
  confirm,
  scenarioIds,
}) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId) || checkpoint === null) {
    return refusal(EXIT_USAGE, `--resume: unknown run-id: ${runId}`);
  }
  const bad = unusable(checkpoint, runId);
  if (bad !== null) return refusal(EXIT_USAGE, bad);
  const unsafe = shaRefusal(checkpoint, rebuiltSha, confirm);
  if (unsafe !== null) return refusal(EXIT_REFUSED, unsafe);
  const done = new Set(checkpoint.results.map((r) => r.id));
  const remaining = scenarioIds.filter((id) => !done.has(id));
  return { exit: null, reason: null, remaining, results: checkpoint.results };
}
