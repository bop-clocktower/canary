/**
 * Regressions from the adversarial review of the #605/#612/#477 chain.
 *
 * Every case below was REPRODUCED against the first cut of these detectors, and
 * they cluster into the two failures that matter most for an instrument whose
 * whole job is finding false green:
 *
 * - **false block** — the gate refusing a correct test (`@covers` leaking to the
 *   next test, taint that never clears, a comment read as code, `.not` read as a
 *   tautology, `$` in an identifier), and
 * - **false green** — the gate passing a defective one (`LINT-004` matching no
 *   axis at all, a `should`-style suite that no vacuity rule can see).
 *
 * Plus one availability bug: an ambiguous template-literal regex that took
 * **five seconds** on a 42-backslash Windows-path fixture and is exponential
 * beyond that. A linter that hangs on a fixture is not advisory, it is down.
 *
 * These live in one file, named for the review rather than split by rule,
 * because that is the honest provenance: they are not cases anyone designed the
 * rules around, they are cases the rules got wrong.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { promotionVerdict } from '../src/core/promotion-verdict.js';
import { StaticLinter, type LintFinding } from '../src/core/static-linter.js';
import { scanVacuity } from '../src/core/vacuity-scanner.js';
import { makeProject, type TempProject } from './scanner-testkit.js';

let project: TempProject | null = null;
afterEach(() => {
  project?.cleanup();
  project = null;
});

function write(name: string, content: string): string {
  project = makeProject({ [name]: content });
  return `${project.root}/${name}`;
}

function lint(name: string, content: string): LintFinding[] {
  return new StaticLinter().lint(write(name, content));
}

const HEAD = `import { it, expect } from 'vitest';\nimport { save, load } from './store.js';\n`;

describe('false block: the gate must not refuse a correct test', () => {
  it('does not leak a @covers annotation onto the next test', () => {
    // The window was a blind 400-character look-back that took the FIRST match
    // in it, so any test declared within ~400 chars of an annotated one
    // inherited the annotation -- and `annotated` is the one vacuity fidelity
    // allowed to BLOCK, so a comment on the previous test failed a good one.
    const r = scanVacuity(
      write(
        'a.test.ts',
        HEAD +
          `// @covers save\n` +
          `it('saves', () => { expect(save(1)).toBe(1); });\n` +
          `it('loads', () => { expect(load(2)).toBe(2); });\n`,
      ),
    );
    expect(r.findings.filter((f) => f.rule === 'VAC-002')).toEqual([]);
  });

  it('takes the NEAREST annotation when several are in range', () => {
    const r = scanVacuity(
      write(
        'a.test.ts',
        HEAD +
          `// @covers save\n` +
          `it('saves', () => { expect(save(1)).toBe(1); });\n` +
          `// @covers load\n` +
          `it('loads', () => { expect(load(2)).toBe(2); });\n`,
      ),
    );
    expect(r.findings.filter((f) => f.rule === 'VAC-002')).toEqual([]);
  });

  it('clears SOUND-001 taint when the name is re-bound deterministically', () => {
    // Taint was written and never invalidated, and the "source" captured was the
    // whole rest of the line rather than the binding's own RHS.
    const findings = lint(
      'a.test.ts',
      HEAD +
        `it('a', () => { const seed = Date.now(); expect(save(seed)).toBe(seed); });\n` +
        `it('b', () => { const seed = 42; expect(save(1)).toBe(seed); });\n`,
    );
    const lines = findings
      .filter((f) => f.rule === 'SOUND-001')
      .map((f) => f.line);
    expect(lines).toEqual([3]);
  });

  it('does not taint a constant bound earlier on the same line', () => {
    const findings = lint(
      'a.test.ts',
      HEAD +
        `it('a', () => { const expected = 3; const now = Date.now(); expect(save(now)).toBe(expected); });\n`,
    );
    expect(findings.filter((f) => f.rule === 'SOUND-001')).toEqual([]);
  });

  it('does not read a trailing comment as code', () => {
    const findings = lint(
      'a.test.ts',
      HEAD +
        `it('sums', () => { expect(save(1)).toBe(3); }); // seeded from process.pid earlier\n`,
    );
    expect(findings.filter((f) => f.rule.startsWith('SOUND-'))).toEqual([]);
  });

  it('does not call a negated matcher a tautology', () => {
    // `expect(v).not.toBe(v)` can only ever FAIL, which is the exact opposite of
    // VAC-001's claim that no implementation can fail it.
    const r = scanVacuity(
      write(
        'a.test.ts',
        HEAD +
          `it('differs', () => { const v = save(1); expect(v).not.toBe(v); });\n`,
      ),
    );
    expect(r.findings.filter((f) => f.rule === 'VAC-001')).toEqual([]);
  });

  it('matches an identifier containing $ — a regex anchor, not a letter', () => {
    // `\b$fetch\b` can only match after a word character, so a `$`-prefixed
    // import never matched and the test reads as touching nothing.
    const r = scanVacuity(
      write(
        'a.test.ts',
        `import { it, expect } from 'vitest';\n` +
          `import { $fetch } from './http.js';\n` +
          `it('fetches', () => { expect($fetch('/x')).toBe(200); });\n`,
      ),
    );
    expect(r.findings.filter((f) => f.rule === 'VAC-002')).toEqual([]);
  });
});

describe('false green: the gate must not pass a defective test', () => {
  it('gates on LINT-004 — an unawaited Playwright action', () => {
    // LINT-004 is `critical` and matched NO axis, so it was neither gating nor
    // advisory nor even printed: the canonical false-green defect walking
    // straight through the gate that exists to stop it.
    const v = promotionVerdict(
      write(
        'a.test.ts',
        `import { it, expect } from 'vitest';\n` +
          `import { save } from './store.js';\n` +
          `it('clicks', async () => {\n  page.click('#a');\n  expect(save(1)).toBe(1);\n});\n`,
      ),
    );
    expect(v.decision).toBe('block');
    expect(v.blocked).toContain('LINT-004');
  });

  it('places every linter rule on some axis', () => {
    // The structural version of the bug above: a rule nobody assigned an axis is
    // invisible to the verdict, and the omission is silent. Asserted over the
    // real rule set rather than a hand-copied list.
    const v = promotionVerdict(
      write(
        'a.test.ts',
        HEAD +
          `it('a', async () => {\n` +
          `  page.click('#a');\n` +
          `  page.locator('.btn');\n` +
          `  await page.waitForTimeout(3000);\n` +
          `  const retryDelay = 4500;\n` +
          `  expect(save(retryDelay)).toBe(0.1);\n` +
          `});\n`,
      ),
    );
    const lintRules = new Set(
      new StaticLinter().lint(v.file).map((f) => f.rule),
    );
    const placed = new Set(
      v.axes.flatMap((a) => a.findings.map((f) => f.rule)),
    );
    for (const rule of lintRules) expect(placed).toContain(rule);
  });

  it.each([
    'save(1).should.equal(1);',
    'assert.equal(save(1), 1);',
    'expectSaved(save(1));',
    'await expect(save(1)).rejects.toThrow();',
  ])('sees the assertion style %s rather than reporting zero', (assertion) => {
    // The vacuity scanner carried its own NARROWER assertion pattern while
    // claiming in a comment to use "the linter's vocabulary". For a suite in any
    // of these styles the assertion list came out empty, VAC-003's
    // `length > 0` guard short-circuited, and the rule reported nothing while
    // nothing said it could not look. It now imports `ASSERT_JS` itself.
    const r = scanVacuity(
      write(
        'a.test.ts',
        `import { save } from './store.js';\n` +
          `it('saves', async () => { ${assertion} });\n`,
      ),
    );
    expect(r.skipped ?? []).toEqual([]);
  });

  it('records a skip when a test has no recognised assertion at all', () => {
    // The residual case, made loud instead of silent: zero recognised assertions
    // is unanswerable for VAC-003, not clean. Either the test asserts nothing
    // (LINT-006's finding, not this rule's) or the style is unknown — and a
    // reader has to be able to tell that the rule abstained.
    const r = scanVacuity(
      write(
        'a.test.ts',
        `import { save } from './store.js';\n` +
          `it('does nothing', () => { save(1); });\n`,
      ),
    );
    expect(r.skipped?.some((s) => /recognised assertion/i.test(s.reason))).toBe(
      true,
    );
  });

  it('flags an inexact fraction with many digits', () => {
    // `10 ** frac.length` passes 2^31 at 10 digits, and `den & (den - 1)`
    // coerces through ToInt32 — for a 32-digit fraction that is `0 & -1 === 0`,
    // i.e. "exactly representable", and the rule went quiet.
    const findings = lint(
      'a.test.ts',
      HEAD +
        `it('rate', () => { expect(save(1)).toBe(0.10000000000000000000000000000001); });\n`,
    );
    expect(findings.map((f) => f.rule)).toContain('SOUND-002');
  });
});

describe('pytest idioms the inference must not go dark on', () => {
  it('reads a parenthesized multi-line import', () => {
    // `PY_FROM_IMPORT` captured to end-of-line, so `from m import (` yielded
    // `"("` and every name was dropped by the identifier filter. If that was the
    // file's only first-party import the target set was empty and BOTH
    // target-dependent rules abstained for the whole file. Loud (the skips were
    // recorded) but a very common import style going unhandled.
    const r = scanVacuity(
      write(
        'test_a.py',
        `from store import (\n    save,\n    load,\n)\n\n` +
          `def test_saves():\n    assert save(1) == 1\n`,
      ),
    );
    expect(r.skipped ?? []).toEqual([]);
    expect(r.findings.filter((f) => f.rule === 'VAC-002')).toEqual([]);
  });

  it('still flags a python test that touches none of those names', () => {
    const r = scanVacuity(
      write(
        'test_a.py',
        `from store import (\n    save,\n    load,\n)\n\n` +
          `def test_nothing():\n    assert 1 + 1 == 2\n`,
      ),
    );
    expect(r.findings.map((f) => f.rule)).toContain('VAC-002');
  });
});

describe('availability: a linter that hangs is not advisory, it is down', () => {
  it('blanks an unterminated template literal in linear time', () => {
    // Measured on the first cut: 42 backslashes took 5.0s, 36 took 142ms, and
    // the growth is exponential — `\\.` and `[^`]` both match a backslash, so
    // the alternation is ambiguous and an absent closing backtick makes the
    // engine explore every parse. Reachable because `blankMultilineStrings`
    // blanks only lines BETWEEN the delimiters, so a multi-line template's
    // opening line always arrives here intact.
    const path = write(
      'a.test.ts',
      HEAD +
        'const p = `C:' +
        '\\'.repeat(60) +
        '\n' +
        `it('a', () => { expect(save(1)).toBe(1); });\n`,
    );
    new StaticLinter().lint(path);
  }, 1000);

  it('handles the same shape in a single-quoted literal', () => {
    const path = write(
      'a.test.ts',
      HEAD +
        "const p = 'C:" +
        '\\'.repeat(60) +
        '\n' +
        `it('a', () => { expect(save(1)).toBe(1); });\n`,
    );
    new StaticLinter().lint(path);
  }, 1000);
});

describe('an internal fault must surface, not degrade to an abstention', () => {
  it('only treats errno-shaped failures as unreadable', () => {
    // The catch classified ANY thrown value with a string `code` as "could not
    // be read". Node programmer errors carry `code` too (ERR_INVALID_ARG_TYPE,
    // ERR_STRING_TOO_LONG), so a real defect inside the linter was reported as a
    // clean ABSTAIN with a misleading reason instead of surfacing.
    const path = write('a.test.ts', HEAD);
    const boom = Object.assign(new Error('internal'), {
      code: 'ERR_INVALID_ARG_TYPE',
    });
    const original = StaticLinter.prototype.lint;
    StaticLinter.prototype.lint = () => {
      throw boom;
    };
    try {
      expect(() => promotionVerdict(path)).toThrow('internal');
    } finally {
      StaticLinter.prototype.lint = original;
    }
  });

  it('still abstains on a genuine errno failure', () => {
    project = makeProject({ 'a.test.ts': '' });
    const v = promotionVerdict(`${project.root}/missing.test.ts`);
    expect(v.decision).toBe('abstain');
  });
});

describe('the denominator says what it actually verified', () => {
  it('surfaces the dark rules in the remedy on a promote', () => {
    // `checked` counts tests VAC-001 really did run on, so it stays as it is —
    // but a `promote` whose other two rules went dark on every test must not
    // read as an unqualified pass.
    const v = promotionVerdict(
      write(
        'a.test.ts',
        `import { it, expect } from 'vitest';\nit('adds', () => { expect(1 + 1).toBe(2); });\n`,
      ),
    );
    expect(v.decision).toBe('promote');
    expect(v.skipped.length).toBeGreaterThan(0);
    expect(v.remedy).toMatch(/could not run|skipped|did not run/i);
  });
});
