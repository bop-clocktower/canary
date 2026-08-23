/**
 * Shared fixtures for the batwoman render suites.
 *
 * The persona registry here is a verbatim copy of the three shipped registers,
 * injected through `resolvePersona({ registry })` so that no test reads
 * `ts/src/data/personas/registry.json` off disk (spec D7).
 *
 * It lives in a testkit rather than beside one of the suites because the
 * invariant suite and the render suite both need it, and importing one
 * `*.test.ts` from another would register its `describe` blocks twice.
 */
import type { PersonaRegistry } from '../src/core/persona.js';
import { resolvePersona } from '../src/core/persona.js';
import { renderReport } from '../src/analysis/batwoman/render.js';
import type {
  ClosureHeader,
  ExerciseVerdict,
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
      audience: 'Writes and owns automated tests daily.',
      depth: 'terse',
      formats: ['bullets', 'code'],
      reasoning: false,
    },
    {
      id: 'junior',
      label: 'Junior SDET',
      audience: 'Writes automated tests but is still building judgement.',
      depth: 'brief',
      formats: ['bullets', 'code', 'rationale'],
      reasoning: true,
    },
    {
      id: 'manual',
      label: 'Manual tester',
      audience: 'Tests by hand and reads test output.',
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

export function v(
  file: string,
  status: ExerciseVerdict['status'],
  explanation = `${file} is ${status} because the fixture says so.`,
): ExerciseVerdict {
  return { file, status, explanation };
}

/** #749's real changed-file shape: 2 / 3 / 2 across three statuses. */
export const MIXED: ExerciseVerdict[] = [
  v(
    '.github/workflows/refresh-arch-baseline.yml',
    'not-exercised',
    'It last ran on 2026-08-10, twelve days before this fix merged, because ' +
      'it is triggered only by the `refresh-baseline` label.',
  ),
  v(
    'scripts/refresh-arch-baseline.mjs',
    'not-exercised',
    'It runs only from refresh-arch-baseline.yml, which has not run since ' +
      'the fix merged, so it has not run either.',
  ),
  v('ts/test/a.test.ts', 'no-probe', 'batwoman has no probe for a test file.'),
  v('ts/test/b.test.ts', 'no-probe', 'batwoman has no probe for a test file.'),
  v('harness.config.json', 'no-probe', 'batwoman has no probe for a config.'),
  v('AGENTS.md', 'not-applicable', 'A document has nothing to execute.'),
  v('CHANGELOG.md', 'not-applicable', 'A document has nothing to execute.'),
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
