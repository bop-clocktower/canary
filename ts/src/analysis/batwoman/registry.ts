/**
 * The probe registry: matching, dispatch, and the two named non-answers.
 *
 * Per spec D3 the gaps have to be countable, so an unmatched file produces a
 * `no-probe` verdict that names what it could not classify rather than
 * silence. The noun phrase comes from the path, not from a probe -- by
 * construction no probe matched, so no probe can supply it.
 * `ExerciseProbe.artifact` is the matched-probe counterpart, used by the probes
 * themselves in Phase 2.
 */

import type {
  ExerciseContext,
  ExerciseProbe,
  ExerciseVerdict,
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
      explanation:
        `batwoman has no probe for this ${describeArtifact(file)}, so ` +
        'nothing looked at whether it has run since the fix merged.',
    };
  }
  try {
    return await probe.probe(file, ctx);
  } catch (err) {
    // Cannot-verify is a finding, not a pass (spec criterion 4). A probe whose
    // evidence source failed knows strictly less than one that never ran, so
    // the only honest answer is abstain -- and the `await` inside the `try` is
    // load-bearing: without it a rejected promise escapes the catch.
    return {
      file,
      status: 'abstain',
      explanation:
        `the ${probe.id} probe looked at this file but could not decide ` +
        'whether it ran, because reading its evidence failed: ' +
        `${err instanceof Error ? err.message : String(err)}.`,
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
