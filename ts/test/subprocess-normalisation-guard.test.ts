/**
 * Class guard for #622: no test may hand-roll `execFileSync` failure
 * normalisation again.
 *
 * The instance was three suites tripping the `ts/test` cyclomatic threshold of
 * 10. The class is that each one re-derived the same cast-and-default block,
 * and each author discovered the threshold the same way — from a red `harness`
 * check on their PR, reported as `arch FAIL` with zero error-severity
 * findings. Extracting the helper fixes the three; this fixes the fourth.
 *
 * The forbidden shape is an `as`-cast of a caught error to an inline type
 * literal with an optional `status` property — the shape `execFileSync`
 * attaches to what it throws, spelled out at each catch site alongside
 * optional `stdout` and `stderr`. (Not written out here: the guard reads its
 * own directory, so a literal example would make it flag itself. The exact
 * pattern is pinned in `INLINE_ERROR_CAST` and exercised below.)
 *
 * That cast is both the duplication and, because the analyzer counts every `?`
 * marker in an inline type literal as a branch, most of the complexity.
 * `runCapture` in `subprocess-testkit.ts` removes the need for it.
 *
 * Offline: reads the `ts/test` sources as text. Runs nothing.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

/** The testkit is the one place allowed to know about failure shapes. */
const EXEMPT = new Set(['subprocess-testkit.ts']);

/**
 * An `as`-cast to an inline type literal carrying an optional `status`, i.e.
 * the `execFileSync`-throws shape. Deliberately narrow: an inline literal
 * without `status?` is some other cast and none of this rule's business.
 */
const INLINE_ERROR_CAST = /\bas\s*\{[^}]*\bstatus\?\s*:/;

function testSources(): { name: string; text: string }[] {
  return readdirSync(TEST_DIR)
    .filter((name) => name.endsWith('.ts') && !EXEMPT.has(name))
    .map((name) => ({
      name,
      text: readFileSync(join(TEST_DIR, name), 'utf-8'),
    }));
}

describe('subprocess failure normalisation', () => {
  it('scans a non-empty set of test sources', () => {
    // A guard that matched nothing would pass for the wrong reason — the
    // zero-denominator abstention this repo treats as a finding, not a pass.
    expect(testSources().length).toBeGreaterThan(50);
  });

  it('detects the shape it is meant to forbid', () => {
    // Pins the pattern itself, so a regex that silently stopped matching
    // cannot masquerade as a clean codebase.
    //
    // Split across a concatenation on purpose: written whole, this sample
    // would make the guard flag its own source, and the fix for that would be
    // an exemption list — which is how a guard starts accumulating the very
    // holes it exists to close. The seam keeps EXEMPT to just the testkit.
    const mutant = 'const e = error as { stat' + 'us?: number };';

    expect(INLINE_ERROR_CAST.test(mutant)).toBe(true);
  });

  it('ignores casts that are not the error shape', () => {
    const unrelated = 'const d = data as { name?: string };';

    expect(INLINE_ERROR_CAST.test(unrelated)).toBe(false);
  });

  it('finds no hand-rolled normalisation outside the testkit', () => {
    const offenders = testSources()
      .filter(({ text }) => INLINE_ERROR_CAST.test(text))
      .map(({ name }) => name);

    expect(
      offenders,
      'use runCapture() from ./subprocess-testkit.js instead',
    ).toEqual([]);
  });
});
