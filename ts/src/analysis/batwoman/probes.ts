/**
 * The three shipped probes (spec Phase 2).
 *
 * Each answers one question about one artifact type: has this thing executed
 * since the fix merged? None of them asserts the fix is correct, and none of
 * them reaches the network -- `ExerciseContext.runs` is the single seam, and
 * the `gh` implementation behind it does not arrive until Phase 3.
 *
 * **A probe that cannot decide throws or abstains; it never guesses.** The
 * registry turns a throw into `abstain`, so a probe is free to let a broken
 * `RunHistoryPort` surface rather than inventing a verdict over history nobody
 * managed to read. Reporting "not exercised" on an unread history would be a
 * claim with no evidence behind it -- the exact defect batwoman exists to find.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { load } from 'js-yaml';
import { describeTriggers } from './triggers.js';
import {
  explain,
  type ExerciseContext,
  type ExerciseProbe,
  type ExerciseVerdict,
  type WorkflowRun,
} from './verdict.js';

const WORKFLOW_DIR = '.github/workflows';
const WORKFLOW_RE = /^\.github\/workflows\/[^/]+\.ya?ml$/;
/** Top-level `scripts/*.mjs` only: nested helpers are not workflow entry points. */
const SCRIPT_RE = /^scripts\/[^/]+\.mjs$/;

/** `2026-08-10`, the grain a human reasons about a run in. */
function day(when: Date): string {
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

/** Decide one workflow from its run history. Shared with the script probe. */
function judgeRuns(
  file: string,
  runs: readonly WorkflowRun[],
  ctx: ExerciseContext,
): ExerciseVerdict {
  const after = runs.filter((r) => r.createdAt > ctx.mergedAt);
  const mostRecent = latest(after);
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

/**
 * `.github/workflows/*.yml` -- decided by run history, explained by `on:`.
 */
export function workflowProbe(): ExerciseProbe {
  return {
    id: 'workflow',
    artifact: 'workflow',
    matches: (file) => WORKFLOW_RE.test(file),
    async probe(file, ctx) {
      return judgeRuns(file, await ctx.runs.runsForWorkflow(file), ctx);
    },
  };
}

/** Workflow files that mention `name`, as repo-relative paths. */
function workflowsReferencing(root: string, name: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(join(root, WORKFLOW_DIR));
  } catch {
    return [];
  }
  // Bounded by a non-word character so `scripts/lint.mjs` is not considered
  // called by a workflow whose only mention is `scripts/lint-staged.mjs`.
  const mention = new RegExp(`(^|[^\\w-])${name.replace(/\./g, '\\.')}(\\W|$)`);
  const found: string[] = [];
  for (const entry of entries.sort()) {
    if (!/\.ya?ml$/.test(entry)) continue;
    const path = `${WORKFLOW_DIR}/${entry}`;
    try {
      if (mention.test(readFileSync(join(root, path), 'utf8')))
        found.push(path);
    } catch {
      // An unreadable workflow cannot be shown to reference the script, so it
      // is not counted as one. It is skipped rather than made fatal.
    }
  }
  return found;
}

/**
 * `scripts/*.mjs` -- resolved statically to the workflows that call it, then
 * decided by their run history.
 *
 * **Abstains when nothing references it**, rather than reporting it never
 * ran. Those are different facts: "no workflow calls this" is a statement
 * about the repo, and it may well be run by a human, a hook, or a workflow
 * that builds the command dynamically. Calling that `not-exercised` would
 * assert something no file supports (spec D3).
 */
/** A caller's file name, which is what a reader recognises it by. */
function named(verdict: ExerciseVerdict): string {
  return basename(verdict.file);
}

/** Nothing under `.github/workflows` mentions the script. */
function unreferencedScript(file: string): ExerciseVerdict {
  return {
    file,
    status: 'abstain',
    explanation: explain(
      'No workflow under .github/workflows references this script, so its ' +
        'execution cannot be traced. It may still be run by hand or from a ' +
        'command this scan cannot see.',
    ),
    evidence: `searched ${WORKFLOW_DIR} for ${basename(file)}`,
  };
}

/** At least one calling workflow ran after the merge, so the script ran too. */
function scriptRanWith(
  file: string,
  ran: ExerciseVerdict,
  callers: readonly string[],
  ctx: ExerciseContext,
): ExerciseVerdict {
  return {
    file,
    status: 'exercised',
    explanation: explain(
      `It is called by ${named(ran)}, which has run since this fix merged, ` +
        'so the script ran with it.',
    ),
    evidence: `${callers.length} referencing workflow(s); ${named(ran)} ran after ${day(ctx.mergedAt)}`,
  };
}

/** Every calling workflow has been dormant since the merge. */
function everyCallerDormant(
  file: string,
  judged: readonly ExerciseVerdict[],
  ctx: ExerciseContext,
): ExerciseVerdict {
  return {
    file,
    status: 'not-exercised',
    explanation: explain(
      `Every workflow that calls it (${judged.map(named).join(', ')}) has ` +
        'been dormant since this fix merged, so the script has not run.',
    ),
    evidence: `${judged.length} referencing workflow(s), none run after ${day(ctx.mergedAt)}`,
  };
}

export function workflowScriptProbe(): ExerciseProbe {
  return {
    id: 'workflow-script',
    artifact: 'workflow script',
    matches: (file) => SCRIPT_RE.test(file),
    async probe(file, ctx) {
      const callers = workflowsReferencing(ctx.root, basename(file));
      if (callers.length === 0) return unreferencedScript(file);

      const judged = await Promise.all(
        callers.map(async (caller) =>
          judgeRuns(caller, await ctx.runs.runsForWorkflow(caller), ctx),
        ),
      );
      const ran = judged.find((v) => v.status === 'exercised');
      return ran === undefined
        ? everyCallerDormant(file, judged, ctx)
        : scriptRanWith(file, ran, callers, ctx);
    },
  };
}

/** Files that are read, not run. Extensions first, then exact names. */
const NO_EXECUTION_EXT = /\.(md|json|ya?ml|toml|ini|txt)$/;
const NO_EXECUTION_NAMES = new Set([
  '.gitignore',
  '.gitattributes',
  '.npmrc',
  '.nvmrc',
  '.prettierignore',
  '.editorconfig',
  'LICENSE',
  'CODEOWNERS',
]);

/**
 * Prose and configuration -- `not-applicable` without reading anything.
 *
 * A workflow is YAML, so the extension alone would swallow every file in
 * `.github/workflows/` and declare it unrunnable. Registration order already
 * puts `workflowProbe` first, but relying on that alone would mean a reordered
 * list silently reclassified every workflow as `not-applicable` -- a whole
 * artifact type disappearing into a status that asks nothing of anyone, which
 * is precisely the silence batwoman exists to remove. The exclusion is stated
 * here so the probe is correct standing alone, and the order is asserted
 * separately.
 */
export function noExecutionProbe(): ExerciseProbe {
  return {
    id: 'no-execution',
    artifact: 'documentation or configuration',
    matches: (file) =>
      !WORKFLOW_RE.test(file) &&
      (NO_EXECUTION_EXT.test(file) || NO_EXECUTION_NAMES.has(basename(file))),
    probe(file) {
      return Promise.resolve({
        file,
        status: 'not-applicable' as const,
        explanation: explain(
          'This file is read rather than run, so "has it executed" is not a ' +
            'question it can answer.',
        ),
      });
    },
  };
}

/**
 * The shipped probes, in match order.
 *
 * Order matters: a workflow file matches both `workflowProbe` and
 * `noExecutionProbe`'s `.yml` extension, and `matchProbe` takes the first
 * match. Everything unmatched becomes a `no-probe` row, which is the honest
 * state for `ts/src/**` in v1 and is countable rather than silent.
 */
export function shippedProbes(): readonly ExerciseProbe[] {
  return [workflowProbe(), workflowScriptProbe(), noExecutionProbe()];
}
