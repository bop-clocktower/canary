/**
 * Turning one fetched window of run history into a verdict.
 *
 * Separated from the probes because it is the part that reasons about *time
 * and evidence* rather than about artifact types: which runs postdate the
 * merge, whether the window saw enough to justify a negative answer, and how
 * a dormant workflow explains itself. Both the workflow probe and the
 * workflow-script probe decide through this one function, so the two cannot
 * drift apart in what they will claim.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describeTriggers } from './triggers.js';
import {
  explain,
  type ExerciseContext,
  type ExerciseVerdict,
  type RunHistory,
  type WorkflowRun,
} from './verdict.js';

/** `2026-08-10`, the grain a human reasons about a run in. */
export function day(when: Date): string {
  return when.toISOString().slice(0, 10);
}

/** The most recent run, or undefined. Order from the port is not assumed. */
function latest(runs: readonly WorkflowRun[]): WorkflowRun | undefined {
  return [...runs].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  )[0];
}

/**
 * The workflow's trigger clause, or null when the file cannot be read.
 *
 * Deliberately swallows every read and parse error. The trigger explanation
 * and the run-history verdict come from different places and fail
 * independently: a workflow deleted by the very PR under audit still has a run
 * history worth reporting, and losing that verdict because its file is gone
 * would be a self-inflicted abstention.
 */
function triggerClause(root: string, file: string): string | null {
  try {
    const doc = load(readFileSync(join(root, file), 'utf8'));
    if (typeof doc !== 'object' || doc === null) return null;
    const record = doc as Record<string, unknown>;
    // `on` is read under both spellings. Under a YAML 1.1 resolver an
    // unquoted `on:` becomes boolean true and the block vanishes; js-yaml
    // 5.4.1 keeps it a string, so this is defence against a parser change
    // rather than a bug being worked around.
    return describeTriggers(record['on'] ?? record['true']);
  } catch {
    return null;
  }
}

/** The sentence a dormant workflow gets: the fact, then the cause. */
function dormantExplanation(
  last: WorkflowRun | undefined,
  clause: string | null,
): string {
  const fact =
    last === undefined
      ? 'It has no recorded runs at all.'
      : `Last ran ${day(last.createdAt)}, before this fix merged.`;
  // Without a clause the sentence stops at the fact. Saying less is the
  // correct degradation; a guessed cause would be acted on.
  return clause === null
    ? fact
    : `${fact} It is ${clause}, so it has not run since.`;
}

/**
 * True when a *negative* answer from this window would be unfounded.
 *
 * **Narrower than the spec's wording, deliberately.** The spec asks the probe
 * to abstain whenever the fetched page "does not reach back past `mergedAt`",
 * reasoning that absence of a qualifying run would then be indistinguishable
 * from truncation. That rationale does not survive contact with the API:
 * `gh run list` returns runs newest-first (verified against this repo), so
 * every run beyond the page is OLDER than every run in it. For a qualifying
 * run to hide outside the window, the oldest fetched run would have to
 * postdate the merge -- and that same condition puts a qualifying run *inside*
 * the window, where the check above has already found it. A dropped-off page
 * therefore cannot conceal a run after the merge.
 *
 * What remains genuinely blind is a window that is both empty and truncated:
 * it reports nothing and admits there is more, which is an absence of evidence
 * rather than evidence of absence. That case abstains.
 *
 * The `complete` flag is kept on {@link RunHistory} regardless. It costs one
 * comparison, it is the honest description of what the port fetched, and it is
 * what makes this argument checkable instead of assumed -- if the ordering
 * guarantee ever changes, this is the one function that has to change with it.
 */
function windowIsBlind(history: RunHistory, _mergedAt: Date): boolean {
  return !history.complete && history.runs.length === 0;
}

/** Decide one workflow from its run history. Shared with the script probe. */
export function judgeRuns(
  file: string,
  history: RunHistory,
  ctx: ExerciseContext,
): ExerciseVerdict {
  const runs = history.runs;
  const after = runs.filter((r) => r.createdAt > ctx.mergedAt);
  const mostRecent = latest(after);
  // Checked before truncation on purpose: a run after the merge is a positive
  // finding, and nothing hidden further back could overturn it.
  if (mostRecent !== undefined) {
    return {
      file,
      status: 'exercised',
      explanation: explain(
        `It has run ${after.length === 1 ? 'once' : `${after.length} times`} ` +
          `since this fix merged, most recently on ${day(mostRecent.createdAt)}.`,
      ),
      evidence: `${runs.length} recorded run(s) for ${file}; ${after.length} after ${day(ctx.mergedAt)}`,
    };
  }

  if (windowIsBlind(history, ctx.mergedAt)) {
    return {
      file,
      status: 'abstain',
      explanation: explain(
        'Its run history came back empty but incomplete, so nothing was ' +
          'learned about whether it has run. This is not a claim that it ' +
          'has not run.',
      ),
      evidence: `an empty but truncated run history for ${file}; nothing reaching back to ${day(ctx.mergedAt)}`,
    };
  }

  const last = latest(runs);
  return {
    file,
    status: 'not-exercised',
    explanation: explain(
      dormantExplanation(last, triggerClause(ctx.root, file)),
    ),
    evidence:
      last === undefined
        ? `no recorded runs for ${file}`
        : `${runs.length} recorded run(s) for ${file}, none after ${day(ctx.mergedAt)}`,
  };
}
