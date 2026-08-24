/**
 * The two guarantees batwoman's verdict model makes at the *type* boundary,
 * asserted by compiling snippets rather than by running them.
 *
 * Both amendments this file guards were review findings against a runtime-only
 * guard that could not fail:
 *
 * - **An explanation can never be empty** (spec criterion 11 / BW-C1). A row
 *   whose sentence is `''` rendered as a bare file path under a status heading,
 *   and the test named to prevent it asserted only that the file name and the
 *   count survived -- both of which the defect preserved. Detecting an empty
 *   sentence downstream was rejected in favour of making it unrepresentable:
 *   `Explanation` is branded, so the only way to obtain one is `explain()`,
 *   which rejects the empty string.
 * - **A success claim must name its evidence** (BW-I4). `exercised` and
 *   `not-exercised` require `evidence`; the three non-answers do not. A
 *   positive claim with nothing behind it is the exact defect batwoman exists
 *   to detect, so permitting it in batwoman's own model is self-undermining.
 *
 * `ts/tsconfig.json` includes only `src`, so a `@ts-expect-error` in a test
 * file is never compiled by any gate -- it would be decoration. This suite runs
 * the real compiler over the real `verdict.ts`, under the repo's own strict
 * options, so removing the brand or widening `evidence` back to optional makes
 * it fail.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(HERE, 'batwoman-type-probe.ts');

/** `ts/tsconfig.json`'s options, which is the point: the gate's own strictness. */
const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  lib: ['lib.es2022.d.ts'],
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  skipLibCheck: true,
  noEmit: true,
};

/**
 * Compile one in-memory snippet against the real source tree.
 *
 * The snippet is served from a path inside `ts/test/` so its relative import of
 * `../src/...` resolves the same way a real test's would; every other file the
 * program pulls in comes off disk unchanged.
 */
function errorLines(snippet: string): number[] {
  const host = ts.createCompilerHost(OPTIONS, true);
  const originalGet = host.getSourceFile.bind(host);
  const originalExists = host.fileExists.bind(host);
  const originalRead = host.readFile.bind(host);
  const isProbe = (name: string) => path.resolve(name) === PROBE;
  host.getSourceFile = (name, languageVersion, onError, shouldCreate) =>
    isProbe(name)
      ? ts.createSourceFile(name, snippet, languageVersion, true)
      : originalGet(name, languageVersion, onError, shouldCreate);
  host.fileExists = (name) => (isProbe(name) ? true : originalExists(name));
  host.readFile = (name) => (isProbe(name) ? snippet : originalRead(name));

  const program = ts.createProgram([PROBE], OPTIONS, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file !== undefined && isProbe(d.file.fileName))
    .map((d) => {
      const { line } = ts.getLineAndCharacterOfPosition(
        // `d.file` is narrowed by the filter above; `start` is set for any
        // diagnostic that carries a file.
        d.file as ts.SourceFile,
        d.start ?? 0,
      );
      return line + 1;
    })
    .sort((a, b) => a - b);
}

/**
 * One snippet, both the valid and the invalid cases, so the valid ones act as
 * the planted positive: if the harness could not compile anything, they would
 * report errors too and the "exactly these lines" assertion would fail rather
 * than pass vacuously.
 *
 * Line numbers are asserted, so keep the numbered comments in step with edits.
 */
const SNIPPET = [
  /* 1 */ "import { explain } from '../src/analysis/batwoman/verdict.js';",
  /* 2 */ "import type { ExerciseVerdict } from '../src/analysis/batwoman/verdict.js';",
  /* 3 */ '',
  /* 4 */ 'export const evidencedPositive: ExerciseVerdict = {',
  /* 5 */ "  file: 'ci.yml',",
  /* 6 */ "  status: 'exercised',",
  /* 7 */ "  explanation: explain('It ran after the merge.'),",
  /* 8 */ "  evidence: 'gh run list --workflow ci.yml',",
  /* 9 */ '};',
  /* 10 */ '',
  /* 11 */ 'export const abstainWithoutEvidence: ExerciseVerdict = {',
  /* 12 */ "  file: 'ci.yml',",
  /* 13 */ "  status: 'abstain',",
  /* 14 */ "  explanation: explain('A probe looked and could not decide.'),",
  /* 15 */ '};',
  /* 16 */ '',
  /* 17 */ 'export const positiveWithoutEvidence: ExerciseVerdict = {',
  /* 18 */ "  file: 'ci.yml',",
  /* 19 */ "  status: 'exercised',",
  /* 20 */ "  explanation: explain('It ran after the merge.'),",
  /* 21 */ '};',
  /* 22 */ '',
  /* 23 */ 'export const emptyExplanation: ExerciseVerdict = {',
  /* 24 */ "  file: 'ci.yml',",
  /* 25 */ "  status: 'abstain',",
  /* 26 */ "  explanation: '',",
  /* 27 */ '};',
  /* 28 */ '',
  /* 29 */ 'export const unvalidatedExplanation: ExerciseVerdict = {',
  /* 30 */ "  file: 'ci.yml',",
  /* 31 */ "  status: 'abstain',",
  /* 32 */ "  explanation: 'a plain string that nothing checked',",
  /* 33 */ '};',
].join('\n');

describe('the verdict type boundary', () => {
  const lines = errorLines(SNIPPET);

  it('rejects an empty explanation and an unbranded one', () => {
    // BW-C1: not "detected downstream" -- unrepresentable. Line 26 is `''`,
    // line 32 is a non-empty string that never went through `explain()`.
    expect(lines).toContain(26);
    expect(lines).toContain(32);
  });

  it('rejects an exercised verdict that names no evidence', () => {
    // BW-I4: the object literal is the error site, so line 17.
    expect(lines).toContain(17);
  });

  it('accepts an abstain verdict with no evidence, and an evidenced positive', () => {
    // The planted positive: these two must compile, or the assertions above
    // would pass merely because nothing compiles.
    expect(lines).not.toContain(4);
    expect(lines).not.toContain(11);
  });

  it('reports errors at exactly the three offending declarations', () => {
    expect(lines).toEqual([17, 26, 32]);
  });
});
