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
