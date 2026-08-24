/**
 * The invariants that bind across every register (spec criteria 3, 8, 11).
 *
 * Kept in their own file and driven by `describe.each` over the three register
 * ids, so that adding a fourth register makes these fail rather than quietly
 * leaving it unasserted. Asserting once against the default is the failure this
 * file exists to prevent: terse output is where a bare check mark is most
 * tempting.
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

/**
 * Records every `readFileSync` path, then delegates to the real implementation.
 *
 * The plan called for `vi.spyOn(fs, 'readFileSync')`, which cannot work here:
 * `ts/package.json` is `type: module`, so the ESM namespace object is frozen
 * and the spy throws `Cannot redefine property`. A hoisted `vi.mock` of a node
 * builtin is the idiom this repo already uses twice -- see `ci-env.test.ts` and
 * `executor.test.ts`, both mocking `node:child_process`.
 *
 * Passthrough, not stub: the other assertions in this file must keep exercising
 * real behaviour.
 */
const fsReads = vi.hoisted(() => [] as string[]);

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      fsReads.push(String(args[0]));
      return actual.readFileSync(...args);
    },
  };
});

import { summaryLine } from '../src/analysis/batwoman/render.js';
import {
  EmptyExplanationError,
  explain,
  type ExerciseVerdict,
} from '../src/analysis/batwoman/verdict.js';
import type { PersonaRegistry } from '../src/core/persona.js';
import {
  ALL_STATUSES,
  FIXTURE_REGISTRY,
  MIXED,
  render,
  v,
} from './batwoman-testkit.js';

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
  ['a run carrying all five statuses', ALL_STATUSES],
  ['an all-exercised run', [v('a.yml', 'exercised'), v('b.yml', 'exercised')]],
  ['an all-not-applicable run', [v('AGENTS.md', 'not-applicable')]],
  ['an empty run', []],
];

/** The summary line as a reader sees it: the last content line of the report. */
function renderedSummary(
  register: string,
  verdicts: ExerciseVerdict[],
): string {
  return render(register, verdicts).trimEnd().split('\n').at(-1) ?? '';
}

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
    // Parsed out of the *rendered* report, not out of `summaryLine(vs)`. As
    // written before, this test never called `render` and never used its
    // `register` parameter -- it ran the identical pure-function assertion
    // three times and would not have noticed a register whose rendered summary
    // was mangled. Invariant 3 is about what a reader sees.
    const numbers = [...renderedSummary(register, vs).matchAll(/(\d+) /g)].map(
      (m) => Number(m[1]),
    );
    const [total, ...columns] = numbers;
    expect(columns).toHaveLength(5);
    expect(columns.reduce((a, b) => a + b, 0)).toBe(total);
    expect(total).toBe(vs.length);
  });

  it('never folds abstain or no-probe into a decided figure', () => {
    // Asserted over `ALL_STATUSES`, where every column is 1. It used to run
    // against `MIXED`, which carries *zero* abstain rows -- so
    // `toContain('0 abstained')` was preserved by any mutation that folded
    // abstain into another column, because there was nothing to fold. Folding
    // abstain into no-probe in `tallyVerdicts` left this whole file green.
    const out = render(register, ALL_STATUSES);
    expect(out).not.toMatch(/\bassessed\b/i);
    expect(out).not.toMatch(/\bdecided\b/i);
    expect(out).toContain('5 changed');
    expect(out).toContain('1 exercised');
    expect(out).toContain('1 not exercised');
    expect(out).toContain('1 abstained');
    expect(out).toContain('1 no probe');
    expect(out).toContain('1 n/a');
  });

  it('keeps abstain and no-probe in sections of their own', () => {
    // The counts above could still be right while the two were rendered as one
    // body section. The terse register prints the raw status on each row and
    // the other two print a heading, so both spellings are accepted -- but they
    // must both be present, and they must not be the same marker.
    const out = render(register, ALL_STATUSES);
    expect(out).toMatch(/ABSTAINED|\babstain\b/);
    expect(out).toMatch(/NO PROBE|\bno-probe\b/);
  });
});

describe.each(REGISTERS)('%s renders sentences, not codes', (register) => {
  it('gives every not-exercised row an observation and a cause', () => {
    // Asserted against the rendered string, not the verdict object: the goal is
    // what a human reads (spec criterion 11).
    const out = render(register, MIXED);
    expect(out).toContain('twelve days before this fix merged');
    expect(out).toContain('`refresh-baseline` label');
    expect(out).toContain('which has not run since');
  });

  it('gives every abstain row an observation and a cause', () => {
    const out = render(register, [
      {
        file: 'ci.yml',
        status: 'abstain',
        explanation: explain(
          'The workflow probe could not decide whether ci.yml ran, because ' +
            'the run history it fetched did not reach back past the merge.',
        ),
      },
    ]);
    expect(out).toContain('could not decide');
    expect(out).toContain('because');
  });

  it('cannot be handed a row with no sentence at all', () => {
    // This test used to render an empty explanation and assert that the file
    // name and the count survived -- both of which the defect preserved, so it
    // could not fail on the thing it was named for. The gap is now
    // unrepresentable: `Explanation` is branded and `explain` rejects the empty
    // string, so the failure happens before any renderer sees the row.
    expect(() => v('x.yml', 'not-exercised', '')).toThrow(
      EmptyExplanationError,
    );
    expect(() => v('x.yml', 'abstain', '   ')).toThrow(EmptyExplanationError);
  });

  it('gives every row a line of its own beyond the file name', () => {
    // The renderer's half of the same invariant: a row is a file line plus at
    // least one line of sentence. Asserted over a fixture carrying all five
    // statuses, whose paths are short enough that each file line is one line.
    const out = render(register, ALL_STATUSES);
    const lines = out.split('\n');
    for (const verdict of ALL_STATUSES) {
      const at = lines.findIndex((line) => line.includes(verdict.file));
      expect(at).toBeGreaterThanOrEqual(0);
      expect((lines[at + 1] ?? '').trim()).not.toBe('');
    }
  });
});

describe('offline guarantee', () => {
  it('observes reads at all, so an empty result means something', () => {
    // The planted positive. Without it, "no personas were read" and "the
    // recorder is broken" produce an identical empty list -- a pass over a
    // denominator of zero, which is the exact shape this whole feature exists
    // to catch. Assert the instrument works before trusting its silence.
    fsReads.length = 0;
    fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(fsReads.length).toBeGreaterThan(0);
  });

  it('renders every register from the injected registry, reading no disk', () => {
    // Unfiltered on purpose. This assertion used to be
    // `fsReads.filter((p) => p.includes('personas'))`, which threw away most of
    // what the recorder had just proved it could see: a renderer reading
    // `package.json`, or anything else off disk, passed it 66/66. Invariant 4
    // is "reads no disk", not "reads no persona file". If a read ever has to be
    // permitted, name the exact path in an allowlist here, so the exception is
    // visible rather than implied by a substring match.
    fsReads.length = 0;
    for (const register of REGISTERS) render(register, MIXED);
    expect(fsReads).toEqual([]);
  });

  it('would notice a read of a path that has nothing to do with personas', () => {
    // The falsification, kept: the assertion above is only worth having if a
    // non-persona read fails it. Reading through the same recorder the renderer
    // would go through proves the recorder sees those paths too.
    fsReads.length = 0;
    fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)));
    expect(fsReads).not.toEqual([]);
    expect(fsReads.some((path) => path.includes('personas'))).toBe(false);
  });
});

/**
 * The drift guard, read from the *shipped* registry.
 *
 * It used to compare `FIXTURE_REGISTRY.personas` against `REGISTERS` -- two
 * constants three lines apart in the test tree, neither of them the file canary
 * actually ships. Appending a fourth persona to
 * `ts/src/data/personas/registry.json` left all 149 batwoman tests green: the
 * guard guarded the copy against itself, which is the "asserted once against the
 * default" failure spec criterion 8 names, one level of indirection up.
 *
 * This is the one test in the file that touches disk, deliberately, and it does
 * so outside the offline assertions above: those reset the recorder before they
 * render, so a read here cannot make them pass. Nothing about invariant 4 is
 * weakened -- the *renderer* still reads nothing; a drift guard by definition
 * has to compare against the artifact it is guarding.
 */
describe('the shipped persona registry', () => {
  const SHIPPED = JSON.parse(
    fs.readFileSync(
      fileURLToPath(
        new URL('../src/data/personas/registry.json', import.meta.url),
      ),
      'utf8',
    ),
  ) as PersonaRegistry;

  it('declares exactly the registers these invariants are asserted over', () => {
    // Add a register to the shipped registry without adding it to REGISTERS and
    // the no-success-token rule is unasserted for it. This is what fails.
    expect(SHIPPED.personas.map((persona) => persona.id).sort()).toEqual(
      [...REGISTERS].sort(),
    );
  });

  it('is what the testkit claims to be a verbatim copy of', () => {
    // The testkit docstring says "a verbatim copy of the three shipped
    // registers". Review found its audience strings were truncated versions of
    // the shipped ones, so the claim was false and nothing could notice. Either
    // the copy is verbatim or the docstring is a lie; this makes it the former.
    expect(FIXTURE_REGISTRY).toEqual(SHIPPED);
  });
});
