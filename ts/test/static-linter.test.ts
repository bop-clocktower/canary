import { afterEach, describe, expect, it } from 'vitest';

import {
  StaticLinter,
  UnsupportedTestFileError,
  formatFinding,
  type Finding,
} from '../src/core/static-linter.js';
import { makeProject, type TempProject } from './scanner-testkit.js';

let project: TempProject | null = null;
afterEach(() => {
  project?.cleanup();
  project = null;
});

function lint(name: string, content: string, framework?: string): Finding[] {
  project = makeProject({ [name]: content });
  return new StaticLinter().lint(`${project.root}/${name}`, framework);
}

function rules(findings: Finding[]): string[] {
  return findings.map((f) => f.rule);
}

describe('StaticLinter', () => {
  it('flags all four flakiness patterns and skips comments', () => {
    const findings = lint(
      'a.spec.ts',
      [
        '// page.waitForTimeout(999) in a comment is ignored',
        'page.waitForTimeout(999);',
        'setTimeout(fn, 100);',
        'const r = Math.random();',
        'const t = Date.now();',
      ].join('\n'),
    );
    expect(rules(findings)).toEqual(
      expect.arrayContaining([
        'FLAKE-001',
        'FLAKE-002',
        'FLAKE-003',
        'FLAKE-004',
      ]),
    );
  });

  it('does not flag setTimeout when waitFor is on the same line', () => {
    const findings = lint('b.spec.ts', 'setTimeout(() => waitFor(x), 10);');
    expect(rules(findings)).not.toContain('FLAKE-002');
  });

  it('flags brittle selectors (class, id, xpath) on locator calls', () => {
    expect(rules(lint('c.spec.ts', "page.locator('.btn').click();"))).toContain(
      'LINT-001',
    );
    expect(rules(lint('d.spec.ts', "page.locator('#id');"))).toContain(
      'LINT-002',
    );
    expect(rules(lint('e.spec.ts', "page.locator('//div[@id]');"))).toContain(
      'LINT-003',
    );
  });

  it('flags a Playwright action without await', () => {
    expect(rules(lint('f.spec.ts', "page.click('x');"))).toContain('LINT-004');
    expect(rules(lint('g.spec.ts', "await page.click('x');"))).not.toContain(
      'LINT-004',
    );
  });

  // LINT-005 is scoped to TIMING values. Dogfooding measured it at 0-for-157
  // actionable on real test code: "extract the magic number" is a
  // production-code principle that inverts in a test, where the literal IS the
  // specification -- `expect(len).toBe(2048)` states the contract that
  // `expect(len).toBe(MAX)` hides. Since this linter only ever reads test
  // files, the unscoped rule was misapplied across its entire domain.
  describe('LINT-005 is scoped to timing values', () => {
    const timing = [
      'setTimeout(fn, 5000);',
      'await page.waitForTimeout(3000);',
      'const opts = { retryDelay: 250 };',
      'const cfg = { timeout: 4321 };',
      'await sleep(1500);',
      'const t = { interval: 750 };',
    ];
    for (const line of timing) {
      it(`flags a timing value: ${line.trim()}`, () => {
        expect(rules(lint('t.spec.ts', line))).toContain('LINT-005');
      });
    }

    const testData = [
      "expect(index['a.py']).toEqual({ 13: 2 });",
      "const ck = loadData({ mcp_servers: ['a'.repeat(129)] });",
      'const ck = loadData({ field: 123 });',
      'const run = { duration_s: 1.5 };',
      'const rows = Array.from({ length: 20 });',
    ];
    for (const line of testData) {
      it(`ignores test data: ${line.trim().slice(0, 42)}`, () => {
        expect(rules(lint('d.spec.ts', line))).not.toContain('LINT-005');
      });
    }

    it('still honours the small-number and HTTP-status allowlists', () => {
      expect(
        rules(lint('i.spec.ts', 'const t = { timeout: 200 };')),
      ).not.toContain('LINT-005');
      expect(rules(lint('j.spec.ts', 'setTimeout(fn, 5);'))).not.toContain(
        'LINT-005',
      );
    });
  });

  it('flags a real timing value but allows small/HTTP-status numbers', () => {
    expect(rules(lint('h.spec.ts', 'const x = { timeout: 42 };'))).toContain(
      'LINT-005',
    );
    expect(rules(lint('i.spec.ts', 'const s = 200;'))).not.toContain(
      'LINT-005',
    );
    expect(rules(lint('j.spec.ts', 'const n = 5;'))).not.toContain('LINT-005');
    expect(rules(lint('k.spec.ts', 'const h = 100;'))).not.toContain(
      'LINT-005',
    );
  });

  it('detects assertion-free JS tests and passes ones with expect()', () => {
    expect(
      rules(lint('l.spec.ts', "test('x', () => { const a = 1; });")),
    ).toContain('LINT-006');
    expect(
      rules(lint('m.spec.ts', "test('y', () => { expect(1).toBe(1); });")),
    ).not.toContain('LINT-006');
  });

  // Third dogfood finding, same family as #499 on the skills side: the FLAKE
  // rules and the missing-await rule matched the RAW line, so a pattern sitting
  // inside a string literal -- i.e. test DATA -- was reported as real code.
  // Canary's own linter tests are the worst case, since they necessarily carry
  // the bad patterns as fixture strings. `scanMagicNumbers` already stripped
  // strings; these scanners never did.
  describe('code rules do not match inside string literals', () => {
    const dataLines: Array<[string, string]> = [
      ["const src = 'const t = Date.now();';", 'FLAKE-004'],
      ["heal(pyFile('import time\\ntime.sleep(2)\\n'));", 'FLAKE-001'],
      ["const src = 'setTimeout(fn, 100);';", 'FLAKE-002'],
      ["const src = 'const r = Math.random();';", 'FLAKE-003'],
      ['const src = "page.click(\'#x\');";', 'LINT-004'],
    ];
    for (const [line, rule] of dataLines) {
      it(`${rule} ignores the pattern inside a string`, () => {
        expect(rules(lint('d.spec.ts', line))).not.toContain(rule);
      });
    }

    const codeLines: Array<[string, string]> = [
      ['const t = Date.now();', 'FLAKE-004'],
      ['await page.waitForTimeout(2000);', 'FLAKE-001'],
      ['setTimeout(fn, 100);', 'FLAKE-002'],
      ['const r = Math.random();', 'FLAKE-003'],
      ["page.click('#x');", 'LINT-004'],
    ];
    for (const [line, rule] of codeLines) {
      it(`${rule} still fires on real code`, () => {
        expect(rules(lint('c.spec.ts', line))).toContain(rule);
      });
    }

    it('selector rules are NOT string-stripped -- their match IS the quotes', () => {
      // LINT-001/002/003 deliberately look inside quotes: the selector is a
      // string by construction. Stripping would delete the rules entirely.
      expect(
        rules(lint('s.spec.ts', "page.locator('.btn').click();")),
      ).toContain('LINT-001');
      expect(rules(lint('u.spec.ts', "page.locator('#id');"))).toContain(
        'LINT-002',
      );
    });
  });

  // Second dogfood finding: `scanMagicNumbers` (and every other per-line rule)
  // works line by line, so the INTERIOR of a multi-line string reads as code.
  // Canary's own diff fixtures are template literals, so `100644` -- a git file
  // mode, inside test DATA -- was reported as a magic number 30 times.
  describe('per-line rules do not read inside multi-line strings', () => {
    it('ignores numbers inside a multi-line template literal', () => {
      const code = [
        'const diff = `',
        'diff --git a/x.ts b/x.ts',
        'index 1111111..2222222 100644',
        '@@ -1,1 +1,7 @@',
        '`;',
        "it('x', () => { expect(diff).toBeTruthy(); });",
      ].join('\n');
      expect(rules(lint('a.spec.ts', code))).not.toContain('LINT-005');
    });

    it('ignores numbers inside a python triple-quoted string', () => {
      const code = [
        'DIFF = """',
        'index 1111111..2222222 100644',
        '"""',
        'def test_x():',
        '    assert DIFF',
      ].join('\n');
      expect(rules(lint('test_x.py', code))).not.toContain('LINT-005');
    });

    it('STILL flags a magic number in real code after the string closes', () => {
      const code = [
        'const diff = `',
        'index 1111111..2222222 100644',
        '`;',
        "it('x', () => { expect(timeout).toBe(4321); });",
      ].join('\n');
      const five = lint('b.spec.ts', code).filter((f) => f.rule === 'LINT-005');
      expect(five).toHaveLength(1);
      expect(five[0]!.message).toContain('4321');
    });

    it('LINT-006 does not read tests inside a multi-line string either', () => {
      // The assertion scanners took the RAW source while the per-line rules
      // took the blanked one, so a diff fixture full of `it(...)` lines was
      // still mined for assertion-free tests. Canary's katana tests carry
      // exactly that shape (deleted `it(` lines inside a diff string).
      const code = [
        'const diff = `',
        'diff --git a/t.spec.ts b/t.spec.ts',
        "-  it('adds to cart', async () => {",
        '-    await page.goto("/");',
        '-  });',
        '`;',
        "it('real', () => { expect(diff).toBeTruthy(); });",
      ].join('\n');
      expect(rules(lint('k.spec.ts', code))).not.toContain('LINT-006');
    });

    it('does not let a lone backtick swallow the rest of the file', () => {
      // An unbalanced backtick (e.g. inside a comment) must not blank every
      // following line -- that would silently disable the rule file-wide, which
      // is the abstention shape one layer down.
      const code = [
        '// a stray ` in a comment',
        "it('x', () => { expect(timeout).toBe(4321); });",
      ].join('\n');
      expect(rules(lint('c.spec.ts', code))).toContain('LINT-005');
    });
  });

  // Found by dogfooding canary on canary (#508 follow-up): `review-test` over
  // canary's own suites reported 216 assertion-free tests, of which 13 were
  // real -- 6% precision. Two independent defects, both pinned below.
  describe('LINT-006 precision (dogfood findings)', () => {
    it('sees node:assert style -- assert.equal is an assertion', () => {
      // 200 of the 216 false positives: ASSERT_JS matched only expect()-style,
      // so every `node:test` + `node:assert` suite read as assertion-free.
      const code = "it('x', () => { assert.equal(1, 1); });";
      expect(rules(lint('a.test.js', code))).not.toContain('LINT-006');
    });

    it('sees the other common node:assert forms', () => {
      for (const call of [
        'assert.ok(x)',
        'assert.deepEqual(a, b)',
        'assert.strictEqual(a, b)',
        'assert.match(s, /x/)',
        'assert.throws(fn)',
        'assert(x)',
      ]) {
        expect(
          rules(lint('b.test.js', `it('x', () => { ${call}; });`)),
        ).not.toContain(`LINT-006`);
      }
    });

    it('counts an expectX()/assertX() helper as an assertion', () => {
      // A test that delegates its assertion to a named helper
      // (`expectAuthoringAllowed(...)`) is asserting; a regex linter cannot
      // follow the call, so the NAME is the signal. 9 of canary's own 16
      // residual LINT-006 findings were this. Same "union of shapes" trade
      // ASSERT_JS already documents -- an import-aware parse is the wrong cost
      // for a static linter.
      for (const call of [
        'expectAuthoringAllowed(r)',
        'assertRecorded(x, y)',
        'expectAbstained(res)',
      ]) {
        expect(
          rules(lint('h.spec.ts', `it('x', () => { ${call}; });`)),
        ).not.toContain('LINT-006');
      }
    });

    it('does not treat an unrelated camelCase call as an assertion', () => {
      // The convention is expect*/assert* specifically; a generic verb must not
      // buy a free pass, or the rule silently stops firing.
      expect(
        rules(lint('i.spec.ts', "it('x', () => { checkoutBranch('main'); });")),
      ).toContain('LINT-006');
    });

    it('finds an assertion PAST the old 2000-char window', () => {
      // 3 of the false positives: the scanner read a fixed 2000-char slice, so
      // a long test whose first assertion came later was flagged.
      const filler = "      const pad = 'x'.repeat(1);\n".repeat(120);
      const code = `it('long', () => {\n${filler}      expect(1).toBe(1);\n});\n`;
      expect(code.length).toBeGreaterThan(2000);
      expect(rules(lint('c.spec.ts', code))).not.toContain('LINT-006');
    });

    it("does NOT borrow the NEXT test's assertion (the false-negative half)", () => {
      // The fixed window also read forward past the end of the test, so an
      // empty test followed by an asserting one could be silently excused.
      const code = [
        "it('empty', () => {",
        '  const a = 1;',
        '});',
        "it('asserts', () => {",
        '  expect(1).toBe(1);',
        '});',
      ].join('\n');
      const six = lint('d.spec.ts', code).filter((f) => f.rule === 'LINT-006');
      expect(six).toHaveLength(1);
      expect(six[0]!.message).toContain('empty');
    });

    it('still flags a genuinely assertion-free test', () => {
      expect(
        rules(lint('e.spec.ts', "it('x', () => { const a = 1; });")),
      ).toContain('LINT-006');
    });
  });

  it('detects assertion-free pytest tests (framework via .py extension)', () => {
    const code = [
      'def test_no_assert():',
      '    value = compute()',
      '',
      'def test_has_assert():',
      '    assert compute() == 1',
    ].join('\n');
    const findings = lint('test_thing.py', code);
    const six = findings.filter((f) => f.rule === 'LINT-006');
    expect(six).toHaveLength(1);
    expect(six[0]!.message).toContain('test_no_assert');
  });

  it('detectFramework: playwright-named file uses the JS assertion path', () => {
    const findings = lint(
      'login.playwright.ts',
      "test('x', () => { const a = 1; });",
    );
    expect(rules(findings)).toContain('LINT-006');
  });

  // Was: "unknown extension falls back to pytest". That fallback is the #566
  // false clean at its source -- it made a `.mjs` file get the Python scanners,
  // which find nothing in ESM JavaScript, so the CLI printed "No issues found"
  // over a file it had never really read. A guess indistinguishable from a
  // clean result is a false green; refusing is the honest answer.
  it('an extension no ruleset parses throws rather than guessing pytest', () => {
    expect(() => lint('weird.txt', 'def test_x():\n    y = 1\n')).toThrow(
      UnsupportedTestFileError,
    );
  });

  it('reads .mjs and .cjs with the JS scanners', () => {
    for (const ext of ['mjs', 'cjs', 'mts', 'cts']) {
      const findings = lint(
        `a.test.${ext}`,
        "test('x', () => { const a = 1; });",
      );
      expect(rules(findings), ext).toContain('LINT-006');
    }
  });

  it('respects an explicit framework override', () => {
    const findings = lint('n.ts', 'def test_x():\n    y = 1\n', 'pytest');
    expect(rules(findings)).toContain('LINT-006');
  });

  it('flakeCheck returns only flakiness findings, sorted by line', () => {
    project = makeProject({
      'o.spec.ts': ['const x = 42;', 'const r = Math.random();'].join('\n'),
    });
    const findings = new StaticLinter().flakeCheck(`${project.root}/o.spec.ts`);
    expect(rules(findings)).toEqual(['FLAKE-003']);
  });

  it('formatFinding renders a readable string', () => {
    // A timing position, since LINT-005 no longer fires on a bare literal.
    const [f] = lint('p.spec.ts', 'const cfg = { timeout: 42 };');
    expect(formatFinding(f!)).toContain('[INFO]');
    expect(formatFinding(f!)).toContain('LINT-005');
  });
});
