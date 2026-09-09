/**
 * The three shipped probes (spec Phase 2).
 *
 * Each answers one question about one artifact type: has this thing executed
 * since the fix merged? None of them asserts the fix is correct, and none of
 * them reaches the network directly -- `ExerciseContext.runs` is the single
 * seam, and the `gh` implementation behind it lives in `gh-history.ts`.
 *
 * **A probe that cannot decide throws or abstains; it never guesses.** The
 * registry turns a throw into `abstain`, so a probe is free to let a broken
 * `RunHistoryPort` surface rather than inventing a verdict over history nobody
 * managed to read. Reporting "not exercised" on an unread history would be a
 * claim with no evidence behind it -- the exact defect batwoman exists to find.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { day, judgeRuns } from './run-window.js';
import {
  explain,
  type ExerciseContext,
  type ExerciseProbe,
  type ExerciseVerdict,
} from './verdict.js';

const WORKFLOW_DIR = '.github/workflows';
const WORKFLOW_RE = /^\.github\/workflows\/[^/]+\.ya?ml$/;
/** Top-level `scripts/*.mjs` only: nested helpers are not workflow entry points. */
const SCRIPT_RE = /^scripts\/[^/]+\.mjs$/;

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

/** At least one calling workflow's history could not be read back far enough. */
function callerHistoryUnknown(
  file: string,
  blind: readonly ExerciseVerdict[],
  judged: readonly ExerciseVerdict[],
): ExerciseVerdict {
  return {
    file,
    status: 'abstain',
    explanation: explain(
      `The run history of ${blind.map(named).join(', ')} was truncated before ` +
        'reaching the merge, so whether this script has run since cannot be ' +
        'told. This is not a claim that it has not run.',
    ),
    evidence: `${judged.length} referencing workflow(s); ${blind.length} with a truncated history`,
  };
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
      if (ran !== undefined) return scriptRanWith(file, ran, callers, ctx);

      // A caller whose own history was truncated has not been shown to be
      // dormant, so the script cannot be called dormant either. Folding an
      // abstention into "every caller dormant" would launder the one status
      // that admits ignorance into a claim (spec Phase 3).
      const blind = judged.filter((v) => v.status === 'abstain');
      if (blind.length > 0) return callerHistoryUnknown(file, blind, judged);

      return everyCallerDormant(file, judged, ctx);
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
