/**
 * The invariants that bind across every register (spec criteria 3, 8, 11).
 *
 * Kept in their own file and driven by `describe.each` over the three register
 * ids, so that adding a fourth register makes these fail rather than quietly
 * leaving it unasserted. Asserting once against the default is the failure this
 * file exists to prevent: terse output is where a bare check mark is most
 * tempting.
 */
import { describe, expect, it } from 'vitest';

import { summaryLine } from '../src/analysis/batwoman/render.js';
import type { ExerciseVerdict } from '../src/analysis/batwoman/verdict.js';
import { FIXTURE_REGISTRY, MIXED, render, v } from './batwoman-testkit.js';

const REGISTERS = ['sdet', 'junior', 'manual'] as const;

/** Glyphs match literally; words need boundaries so `look` is not `OK`. */
const GLYPHS = ['✓', '✔', '✅', '☑'];
const WORDS = [
  /\bOK\b/,
  /\bclean\b/i,
  /\bpassed\b/i,
  /\bsuccess(ful)?\b/i,
  /\ball clear\b/i,
  /\bno issues\b/i,
];

const CASES: ReadonlyArray<readonly [string, ExerciseVerdict[]]> = [
  ['a run with findings', MIXED],
  ['an all-exercised run', [v('a.yml', 'exercised'), v('b.yml', 'exercised')]],
  ['an all-not-applicable run', [v('AGENTS.md', 'not-applicable')]],
  ['an empty run', []],
];

describe.each(REGISTERS)('the %s register', (register) => {
  it.each(CASES)('prints no success glyph over %s', (_name, verdicts) => {
    const out = render(register, verdicts);
    for (const glyph of GLYPHS) expect(out).not.toContain(glyph);
  });

  it.each(CASES)('prints no success word over %s', (_name, verdicts) => {
    const out = render(register, verdicts);
    for (const word of WORDS) expect(out).not.toMatch(word);
  });

  it.each(CASES)('ends with the full summary line over %s', (_n, verdicts) => {
    const out = render(register, verdicts).trimEnd();
    expect(out.endsWith(summaryLine(verdicts))).toBe(true);
  });

  it.each(CASES)('sums its summary columns to the total over %s', (_n, vs) => {
    const numbers = [...summaryLine(vs).matchAll(/(\d+) /g)].map((m) =>
      Number(m[1]),
    );
    const [total, ...columns] = numbers;
    expect(columns.reduce((a, b) => a + b, 0)).toBe(total);
    expect(total).toBe(vs.length);
  });

  it('never folds abstain or no-probe into a decided figure', () => {
    const out = render(register, MIXED);
    expect(out).not.toMatch(/\bassessed\b/i);
    expect(out).not.toMatch(/\bdecided\b/i);
    expect(out).toContain('0 abstained');
    expect(out).toContain('3 no probe');
  });
});

it('asserts every register the fixture registry declares', () => {
  // A fourth register added to the registry without being added here would
  // leave the no-success-token rule unasserted for it -- the exact "asserted
  // once against the default" failure spec criterion 8 names.
  expect(FIXTURE_REGISTRY.personas.map((p) => p.id).sort()).toEqual(
    [...REGISTERS].sort(),
  );
});
