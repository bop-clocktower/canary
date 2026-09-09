/**
 * The probe registry: matching, dispatch, and the two named non-answers.
 *
 * Per spec D3 the gaps have to be countable, so an unmatched file produces a
 * `no-probe` verdict that names what it could not classify rather than
 * silence. The noun phrase comes from the path, not from a probe -- by
 * construction no probe matched, so no probe can supply it.
 * `ExerciseProbe.artifact` is the matched-probe counterpart, supplied by the
 * probes themselves (see `probes.ts`).
 */

import {
  CLAIMING_STATUSES,
  EXERCISE_STATUSES,
  explain,
  isExplanation,
  type ExerciseContext,
  type ExerciseProbe,
  type ExerciseStatus,
  type ExerciseVerdict,
} from './verdict.js';

/**
 * Path patterns to the noun phrase a NO PROBE row prints.
 *
 * Order is load-bearing: `*.test.ts` must be read as a test file before the
 * generic source-module rule claims it, and a skill's `SKILL.md` before the
 * generic document rule. The final fallback is a phrase rather than an empty
 * string, because a row that names nothing is the silence D3 exists to remove.
 */
const ARTIFACT_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\.(test|spec)\.[cm]?[jt]sx?$/, 'test file'],
  [/^agents\/skills\/.+\.md$/, 'skill document'],
  [/\.(json|ya?ml|toml|ini|lock)$/, 'config'],
  [/\.[cm]?[jt]sx?$/, 'source module'],
  [/\.md$/, 'document'],
];

/** The noun phrase for a file, for use in a `no-probe` row. */
export function describeArtifact(file: string): string {
  for (const [pattern, noun] of ARTIFACT_RULES) {
    if (pattern.test(file)) return noun;
  }
  return 'unrecognised artifact';
}

/** The first probe claiming this file, or null. */
export function matchProbe(
  probes: readonly ExerciseProbe[],
  file: string,
): ExerciseProbe | null {
  return probes.find((probe) => probe.matches(file)) ?? null;
}

/** An `abstain` naming the probe and what was wrong with its answer. */
function distrust(
  probeId: string,
  file: string,
  fault: string,
): ExerciseVerdict {
  return {
    file,
    status: 'abstain',
    explanation: explain(
      `the ${probeId} probe answered about this file but batwoman could not ` +
        `trust its verdict, because ${fault}; the file is therefore ` +
        'unassessed rather than clean.',
    ),
    evidence: `${probeId} probe answer`,
  };
}

/**
 * What is wrong with a probe's answer, or `null` if nothing is.
 *
 * The type boundary in `verdict.ts` makes each of these unrepresentable in
 * TypeScript, so this is the seam for answers arriving from outside it: a
 * JavaScript probe, a plugin, a `JSON.parse`. It matters because an out-of-
 * union status reaches `tallyVerdicts`, where `byStatus[status] += 1` yields
 * `NaN` and the summary line stops summing to its own denominator -- a
 * false-green shape one level up from the one batwoman detects.
 */
function faultIn(answer: unknown, file: string): string | null {
  if (typeof answer !== 'object' || answer === null) {
    return (
      `it returned ${answer === null ? 'null' : typeof answer} rather ` +
      'than a verdict'
    );
  }
  const verdict = answer as Partial<Record<keyof ExerciseVerdict, unknown>>;
  if (verdict.file !== file) {
    return `it answered about ${String(verdict.file)} instead`;
  }
  if (!EXERCISE_STATUSES.includes(verdict.status as ExerciseStatus)) {
    return `'${String(verdict.status)}' is not one of the five statuses`;
  }
  if (!isExplanation(verdict.explanation)) {
    return (
      'it supplied no explanation, and a row that names a file and says ' +
      'nothing about it is not a verdict'
    );
  }
  const claims = CLAIMING_STATUSES.includes(
    verdict.status as (typeof CLAIMING_STATUSES)[number],
  );
  if (claims && typeof verdict.evidence !== 'string') {
    return (
      `a '${String(verdict.status)}' claim must name the evidence ` +
      'behind it, and this one named none'
    );
  }
  return null;
}

/** One file's verdict, via the probe that claims it. */
export async function probeFile(
  probes: readonly ExerciseProbe[],
  file: string,
  ctx: ExerciseContext,
): Promise<ExerciseVerdict> {
  const probe = matchProbe(probes, file);
  if (probe === null) {
    return {
      file,
      status: 'no-probe',
      explanation: explain(
        `batwoman has no probe for this ${describeArtifact(file)}, so ` +
          'nothing looked at whether it has run since the fix merged.',
      ),
    };
  }
  try {
    const answer: unknown = await probe.probe(file, ctx);
    const fault = faultIn(answer, file);
    return fault === null
      ? (answer as ExerciseVerdict)
      : distrust(probe.id, file, fault);
  } catch (err) {
    // Cannot-verify is a finding, not a pass (spec criterion 4). A probe whose
    // evidence source failed knows strictly less than one that never ran, so
    // the only honest answer is abstain -- and the `await` inside the `try` is
    // load-bearing: without it a rejected promise escapes the catch.
    return {
      file,
      status: 'abstain',
      explanation: explain(
        `the ${probe.id} probe looked at this file but could not decide ` +
          'whether it ran, because reading its evidence failed: ' +
          `${err instanceof Error ? err.message : String(err)}.`,
      ),
      evidence: `${probe.id} probe error`,
    };
  }
}

/**
 * Probe every changed file, in input order, one at a time.
 *
 * Sequential rather than `Promise.all`: the real port shells out to `gh`, and a
 * fan-out over a whole changed-file set would turn one audit into a burst of
 * API calls. Order is preserved so the report is reproducible.
 */
export async function probeAll(
  probes: readonly ExerciseProbe[],
  files: readonly string[],
  ctx: ExerciseContext,
): Promise<ExerciseVerdict[]> {
  const verdicts: ExerciseVerdict[] = [];
  for (const file of files) verdicts.push(await probeFile(probes, file, ctx));
  return verdicts;
}
