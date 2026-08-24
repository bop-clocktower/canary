/**
 * Shared fixtures for the batwoman render suites.
 *
 * The persona registry here is a verbatim copy of the three shipped registers,
 * injected through `resolvePersona({ registry })` so that no test reads
 * `ts/src/data/personas/registry.json` off disk (spec D7).
 *
 * "Verbatim" is enforced, not asserted in prose: `batwoman-render-invariants`
 * deep-compares this object against the shipped JSON. Review found the audience
 * strings had already drifted into truncated paraphrases while the docstring
 * still claimed a verbatim copy, so the claim now has a test behind it.
 *
 * It lives in a testkit rather than beside one of the suites because the
 * invariant suite and the render suite both need it, and importing one
 * `*.test.ts` from another would register its `describe` blocks twice.
 */
import type { PersonaRegistry } from '../src/core/persona.js';
import { resolvePersona } from '../src/core/persona.js';
import { renderReport } from '../src/analysis/batwoman/render.js';
import {
  explain,
  type ClosureHeader,
  type ExerciseVerdict,
} from '../src/analysis/batwoman/verdict.js';

export const FIXTURE_REGISTRY: PersonaRegistry = {
  version: 1,
  fallback: 'junior',
  minDetectionConfidence: 0.5,
  minDetectionSignals: 2,
  detectionMap: { sdet: 'sdet', manual: 'manual' },
  personas: [
    {
      id: 'sdet',
      label: 'Senior SDET',
      audience:
        'Writes and owns automated tests daily; fluent in the framework ' +
        'and the codebase.',
      depth: 'terse',
      formats: ['bullets', 'code'],
      reasoning: false,
    },
    {
      id: 'junior',
      label: 'Junior SDET',
      audience:
        'Writes automated tests but is still building judgement about which ' +
        'ones matter.',
      depth: 'brief',
      formats: ['bullets', 'code', 'rationale'],
      reasoning: true,
    },
    {
      id: 'manual',
      label: 'Manual tester',
      audience:
        'Tests by hand and reads test output; may not read or write the ' +
        "framework's code.",
      depth: 'guided',
      formats: ['numbered-steps', 'rationale'],
      reasoning: true,
    },
  ],
};

export const HEADER: ClosureHeader = {
  issue: 749,
  mergeSha: '1e0c05b',
  mergeSubject: 'fix(ci): make the refresh-baseline label refresh the baseline',
  mergedAt: new Date('2026-08-22T17:34:00Z'),
};

/**
 * One fixture verdict.
 *
 * `exercised` and `not-exercised` carry evidence because the model requires it
 * of any claim (spec's amended verdict model): a positive with nothing behind
 * it is the defect batwoman detects, committed by batwoman.
 */
export function v(
  file: string,
  status: ExerciseVerdict['status'],
  text = `${file} is ${status} because the fixture says so.`,
  evidence = `the ${status} fixture`,
): ExerciseVerdict {
  const explanation = explain(text);
  return status === 'exercised' || status === 'not-exercised'
    ? { file, status, explanation, evidence }
    : { file, status, explanation };
}

/** #749's real changed-file shape: 2 / 3 / 2 across three statuses. */
export const MIXED: ExerciseVerdict[] = [
  v(
    '.github/workflows/refresh-arch-baseline.yml',
    'not-exercised',
    'It last ran on 2026-08-10, twelve days before this fix merged, because ' +
      'it is triggered only by the `refresh-baseline` label.',
    'gh run list --workflow refresh-arch-baseline.yml',
  ),
  v(
    'scripts/refresh-arch-baseline.mjs',
    'not-exercised',
    'It runs only from refresh-arch-baseline.yml, which has not run since ' +
      'the fix merged, so it has not run either.',
    'refresh-arch-baseline.yml, which names this script',
  ),
  v('ts/test/a.test.ts', 'no-probe', 'batwoman has no probe for a test file.'),
  v('ts/test/b.test.ts', 'no-probe', 'batwoman has no probe for a test file.'),
  v('harness.config.json', 'no-probe', 'batwoman has no probe for a config.'),
  v('AGENTS.md', 'not-applicable', 'A document has nothing to execute.'),
  v('CHANGELOG.md', 'not-applicable', 'A document has nothing to execute.'),
];

/**
 * One row of every one of the five statuses.
 *
 * `MIXED` carries no `abstain` row, so every assertion made against it about
 * the abstain column was asserted over a count of zero -- preserved by any
 * mutation that folded abstain into another column, because there was nothing
 * to fold. A fixture where no column is zero is what makes those guards able to
 * fail. Paths are kept short and mutually non-overlapping so a test can find a
 * row by its file name.
 */
export const ALL_STATUSES: ExerciseVerdict[] = [
  v(
    '.github/workflows/release.yml',
    'not-exercised',
    'It has not run since the fix merged, because it is triggered only by a ' +
      'tag push and no tag has been pushed.',
    'gh run list --workflow release.yml',
  ),
  v(
    '.github/workflows/deploy.yml',
    'abstain',
    'The workflow probe could not decide whether it ran, because the run ' +
      'history it fetched did not reach back past the merge.',
    'gh run list --workflow deploy.yml --limit 100',
  ),
  v(
    'ts/src/core/persona.ts',
    'no-probe',
    'batwoman has no probe for this source module, so nothing looked at ' +
      'whether it has run since the fix merged.',
  ),
  v(
    '.github/workflows/ci.yml',
    'exercised',
    'It ran on 2026-08-23, after this fix merged, on a push to main.',
    'gh run list --workflow ci.yml',
  ),
  v(
    'AGENTS.md',
    'not-applicable',
    'A document has nothing to execute, so there is nothing to have run.',
  ),
];

/** Render one register over one verdict set, from the injected registry. */
export function render(
  explicit: string | null,
  verdicts: readonly ExerciseVerdict[] = MIXED,
): string {
  return renderReport({
    header: HEADER,
    repo: 'canary',
    verdicts,
    persona: resolvePersona({ explicit, registry: FIXTURE_REGISTRY }),
  });
}
