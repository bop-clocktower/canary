/**
 * Diff-scoped mutation testing, tool-independent core (#486).
 *
 * The load-bearing tests here are the abstention ones. A mutation check that
 * cannot run has exactly one honest answer, and it is not "0 survived".
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MUTANT_CAP,
  RUNNER_ISSUE,
  mutateEntries,
  runnerCompatibility,
  sampleMutants,
  threadUnsafeTests,
} from '../src/guardian/mutation.js';
import {
  abstainedReport,
  applyMutantSuppressions,
  mapStrykerReport,
  mutantSuppressionReason,
  mutationExitCode,
  renderMutationReport,
} from '../src/guardian/mutation-report.js';
import type { StrykerReport } from '../src/guardian/mutation.js';

/** A Stryker JSON report with one mutant per (line, status) tuple. */
function report(
  mutants: Array<{
    line: number;
    status: string;
    coveredBy?: string[];
    mutator?: string;
    replacement?: string;
  }>,
  path = 'ts/src/guardian/pr-check.ts',
): StrykerReport {
  return {
    schemaVersion: '1',
    files: {
      [path]: {
        language: 'typescript',
        source: '',
        mutants: mutants.map((m, i) => ({
          id: String(i),
          mutatorName: m.mutator ?? 'ConditionalExpression',
          replacement: m.replacement ?? 'false',
          status: m.status,
          location: { start: { line: m.line, column: 1 } },
          ...(m.coveredBy === undefined ? {} : { coveredBy: m.coveredBy }),
        })),
      },
    },
    testFiles: {
      'ts/test/a.test.ts': {
        tests: [
          { id: 't1', name: 'suppression strips the reason' },
          { id: 't2', name: 'suppression keeps the finding' },
        ],
      },
    },
  };
}

const NO_EXCLUSIONS: string[] = [];

describe('mutateEntries', () => {
  it('emits one path:start-end entry per added range', () => {
    expect(
      mutateEntries([
        { path: 'ts/src/a.ts', added_ranges: [[3, 5]] },
        { path: 'ts/src/b.ts', added_ranges: [[9, 9]] },
      ]),
    ).toEqual(['ts/src/a.ts:3-5', 'ts/src/b.ts:9-9']);
  });

  it('drops paths outside ts/src (F3: only what vitest coverage maps)', () => {
    expect(
      mutateEntries([
        {
          path: 'agents/skills/claude-code/x/scripts/cli.mjs',
          added_ranges: [[1, 2]],
        },
        { path: 'ts/test/a.test.ts', added_ranges: [[1, 2]] },
        { path: 'ts/src/keep.ts', added_ranges: [[1, 2]] },
      ]),
    ).toEqual(['ts/src/keep.ts:1-2']);
  });

  it('emits nothing for an empty scope, so the caller abstains', () => {
    expect(mutateEntries([])).toEqual([]);
  });
});

describe('sampleMutants (D7/F4: a cap that states its denominator)', () => {
  const many = Array.from({ length: MUTANT_CAP + 5 }, (_, i) => ({
    path: 'ts/src/a.ts',
    line: MUTANT_CAP + 5 - i,
    mutator: 'ConditionalExpression',
    replacement: 'false',
    status: 'survived' as const,
    coveredBy: ['t'],
  }));

  it('keeps the cap, deterministically ordered by path then line', () => {
    const first = sampleMutants(many, MUTANT_CAP);
    expect(first.sampled).toHaveLength(MUTANT_CAP);
    expect(first.generated).toBe(MUTANT_CAP + 5);
    expect(first.sampled[0]!.line).toBe(1);
    expect(sampleMutants(many, MUTANT_CAP).sampled).toEqual(first.sampled);
  });

  it('is identity at or under the cap', () => {
    const few = many.slice(0, 3);
    const result = sampleMutants(few, MUTANT_CAP);
    expect(result.sampled).toHaveLength(3);
    expect(result.generated).toBe(3);
  });
});

describe('runnerCompatibility (the abstain guard, F6)', () => {
  it('refuses the runner that runs zero tests per mutant on vitest 5', () => {
    const verdict = runnerCompatibility('10.0.0', '5.0.0');
    expect(verdict.compatible).toBe(false);
    expect(verdict.reason).toContain(RUNNER_ISSUE);
  });

  it('refuses an absent runner rather than assuming it would have worked', () => {
    const verdict = runnerCompatibility(null, '5.0.0');
    expect(verdict.compatible).toBe(false);
    expect(verdict.reason).toContain('not installed');
  });

  it('accepts a newer runner and an older vitest', () => {
    expect(runnerCompatibility('10.1.0', '5.0.0').compatible).toBe(true);
    expect(runnerCompatibility('10.0.0', '4.9.0').compatible).toBe(true);
  });

  it('refuses an unparseable version rather than guessing', () => {
    expect(runnerCompatibility('next', '5.0.0').compatible).toBe(false);
  });
});

describe('mapStrykerReport', () => {
  it('maps every stryker status onto the guardian model', () => {
    const mapped = mapStrykerReport(
      report([
        { line: 10, status: 'Killed', coveredBy: ['t1'] },
        { line: 11, status: 'Survived', coveredBy: ['t1', 't2'] },
        { line: 12, status: 'NoCoverage' },
        { line: 13, status: 'Timeout', coveredBy: ['t1'] },
      ]),
      { excludedTests: NO_EXCLUSIONS },
    );
    expect(mapped.findings.map((f) => f.status)).toEqual([
      'killed',
      'survived',
      'no-coverage',
      'timeout',
    ]);
    expect(mapped.killed).toBe(1);
    expect(mapped.survived).toBe(1);
    expect(mapped.noCoverage).toBe(1);
    expect(mapped.verdict).toBe('survivors');
  });

  it('resolves coveredBy test ids to the names that failed to kill (SC-2)', () => {
    const mapped = mapStrykerReport(
      report([{ line: 11, status: 'Survived', coveredBy: ['t1', 't2'] }]),
      { excludedTests: NO_EXCLUSIONS },
    );
    expect(mapped.findings[0]!.coveredBy).toEqual([
      'suppression strips the reason',
      'suppression keeps the finding',
    ]);
  });

  it('demotes a survivor with no covering test to no-coverage (SC-2)', () => {
    const mapped = mapStrykerReport(
      report([{ line: 11, status: 'Survived', coveredBy: [] }]),
      { excludedTests: NO_EXCLUSIONS },
    );
    expect(mapped.findings[0]!.status).toBe('no-coverage');
    expect(mapped.survived).toBe(0);
  });

  it('reports all-killed with the denominator intact', () => {
    const mapped = mapStrykerReport(
      report([
        { line: 10, status: 'Killed', coveredBy: ['t1'] },
        { line: 11, status: 'Killed', coveredBy: ['t1'] },
      ]),
      { excludedTests: NO_EXCLUSIONS },
    );
    expect(mapped.verdict).toBe('all-killed');
    expect(mapped.generated).toBe(2);
    expect(mapped.sampled).toBe(2);
  });

  it('discloses the excluded thread-unsafe tests on every report (F6)', () => {
    const mapped = mapStrykerReport(
      report([{ line: 10, status: 'Killed', coveredBy: ['t1'] }]),
      { excludedTests: ['test/guardian-cli.test.ts'] },
    );
    expect(mapped.excludedTests).toEqual(['test/guardian-cli.test.ts']);
  });
});

describe('abstention (D6, ADR 0009 — a zero denominator is not a pass)', () => {
  it('abstains when stryker generated no mutants', () => {
    const mapped = mapStrykerReport(report([]), {
      excludedTests: NO_EXCLUSIONS,
    });
    expect(mapped.verdict).toBe('abstained');
    expect(mapped.abstainReason).toContain('zero mutants');
  });

  it('abstains when no mutant was covered by any test', () => {
    const mapped = mapStrykerReport(
      report([
        { line: 10, status: 'NoCoverage' },
        { line: 11, status: 'NoCoverage' },
      ]),
      { excludedTests: NO_EXCLUSIONS },
    );
    expect(mapped.verdict).toBe('abstained');
    expect(mapped.survived).toBe(0);
  });

  it('never carries a survived finding on an abstention', () => {
    const abstained = abstainedReport('stryker crashed', ['test/a.test.ts']);
    expect(abstained.verdict).toBe('abstained');
    expect(abstained.findings).toEqual([]);
    expect(abstained.survived).toBe(0);
    expect(abstained.generated).toBe(0);
    expect(abstained.excludedTests).toEqual(['test/a.test.ts']);
  });

  it('exits 3 on abstention, 1 on survivors, 0 on all-killed', () => {
    expect(mutationExitCode(abstainedReport('no diff', NO_EXCLUSIONS))).toBe(3);
    expect(
      mutationExitCode(
        mapStrykerReport(
          report([{ line: 11, status: 'Survived', coveredBy: ['t1'] }]),
          { excludedTests: NO_EXCLUSIONS },
        ),
      ),
    ).toBe(1);
    expect(
      mutationExitCode(
        mapStrykerReport(
          report([{ line: 11, status: 'Killed', coveredBy: ['t1'] }]),
          { excludedTests: NO_EXCLUSIONS },
        ),
      ),
    ).toBe(0);
  });
});

describe('canary:allow-mutant suppression (D9, SC-5)', () => {
  it('reads a reason from either comment leader', () => {
    expect(
      mutantSuppressionReason('const x = 1; // canary:allow-mutant equivalent'),
    ).toBe('equivalent');
    expect(
      mutantSuppressionReason('x = 1  # canary:allow-mutant equivalent'),
    ).toBe('equivalent');
  });

  it('ignores a bare marker with no reason', () => {
    expect(mutantSuppressionReason('const x = 1; // canary:allow-mutant')).toBe(
      null,
    );
  });

  it('moves a suppressed survivor out of the survived count', () => {
    const mapped = mapStrykerReport(
      report(
        [{ line: 2, status: 'Survived', coveredBy: ['t1'] }],
        'ts/src/a.ts',
      ),
      { excludedTests: NO_EXCLUSIONS },
    );
    const suppressed = applyMutantSuppressions(mapped, {
      'ts/src/a.ts': [
        'const a = 1;',
        'const b = 2; // canary:allow-mutant equivalent',
      ],
    });
    expect(suppressed.survived).toBe(0);
    expect(suppressed.suppressed).toHaveLength(1);
    expect(suppressed.suppressed[0]!.reason).toBe('equivalent');
    // Nothing was killed once the only mutant was suppressed, so the run
    // abstains rather than claiming a clean pass it did not earn.
    expect(suppressed.verdict).toBe('abstained');
  });

  it('still reports all-killed when a kill survives the suppression pass', () => {
    const mapped = mapStrykerReport(
      report(
        [
          { line: 1, status: 'Killed', coveredBy: ['t1'] },
          { line: 2, status: 'Survived', coveredBy: ['t1'] },
        ],
        'ts/src/a.ts',
      ),
      { excludedTests: NO_EXCLUSIONS },
    );
    const suppressed = applyMutantSuppressions(mapped, {
      'ts/src/a.ts': [
        'const a = 1;',
        'const b = 2; // canary:allow-mutant equivalent',
      ],
    });
    expect(suppressed.verdict).toBe('all-killed');
    expect(suppressed.survived).toBe(0);
  });

  it('leaves a survivor alone when the marker carries no reason', () => {
    const mapped = mapStrykerReport(
      report(
        [{ line: 1, status: 'Survived', coveredBy: ['t1'] }],
        'ts/src/a.ts',
      ),
      { excludedTests: NO_EXCLUSIONS },
    );
    const suppressed = applyMutantSuppressions(mapped, {
      'ts/src/a.ts': ['const a = 1; // canary:allow-mutant'],
    });
    expect(suppressed.survived).toBe(1);
  });
});

describe('renderMutationReport', () => {
  it('always shows the denominator', () => {
    const text = renderMutationReport(
      mapStrykerReport(
        report([
          { line: 10, status: 'Killed', coveredBy: ['t1'] },
          { line: 11, status: 'Killed', coveredBy: ['t1'] },
        ]),
        { excludedTests: NO_EXCLUSIONS },
      ),
    );
    expect(text).toContain('2/2 mutants killed');
  });

  it('says so when the cap truncated the run', () => {
    const mapped = mapStrykerReport(
      report([{ line: 10, status: 'Killed', coveredBy: ['t1'] }]),
      { excludedTests: NO_EXCLUSIONS, generated: 400 },
    );
    expect(renderMutationReport(mapped)).toContain('sampled 1 of 400');
  });

  it('renders an abstention as an abstention, never as a pass', () => {
    const text = renderMutationReport(
      abstainedReport(`runner incompatible, ${RUNNER_ISSUE}`, NO_EXCLUSIONS),
    );
    expect(text).toContain('Abstained');
    expect(text).toContain(RUNNER_ISSUE);
    expect(text).not.toContain('0 survived');
    expect(text).not.toContain('mutants killed');
  });

  it('discloses the excluded tests in the rendered body (F6)', () => {
    const text = renderMutationReport(
      abstainedReport('no diff', ['test/guardian-cli.test.ts']),
    );
    expect(text).toContain('test/guardian-cli.test.ts');
    expect(text).toContain('excluded');
  });
});

describe('threadUnsafeTests', () => {
  it('lists the suites Stryker cannot run, repo-relative and sorted', () => {
    const root = mkdtempSync(join(tmpdir(), 'canary-mutation-'));
    mkdirSync(join(root, 'test'), { recursive: true });
    mkdirSync(join(root, 'src', 'guardian'), { recursive: true });
    writeFileSync(join(root, 'test', 'a.test.ts'), 'process.chdir(dir);');
    writeFileSync(
      join(root, 'test', 'b.test.ts'),
      "import { run } from './guardian-cli-testkit.js';",
    );
    writeFileSync(join(root, 'test', 'c.test.ts'), 'expect(1).toBe(1);');
    writeFileSync(
      join(root, 'src', 'guardian', 'd.test.ts'),
      'process.chdir(dir);',
    );
    expect(threadUnsafeTests(root)).toEqual([
      'src/guardian/d.test.ts',
      'test/a.test.ts',
      'test/b.test.ts',
    ]);
  });
});
