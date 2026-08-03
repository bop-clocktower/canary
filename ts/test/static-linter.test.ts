import { afterEach, describe, expect, it } from 'vitest';

import {
  StaticLinter,
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

  it('flags real magic numbers but allows small/HTTP-status numbers', () => {
    expect(rules(lint('h.spec.ts', 'const x = 42;'))).toContain('LINT-005');
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

  it('detectFramework: unknown extension falls back to pytest', () => {
    const findings = lint('weird.txt', 'def test_x():\n    y = 1\n');
    expect(rules(findings)).toContain('LINT-006');
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
    const [f] = lint('p.spec.ts', 'const x = 42;');
    expect(formatFinding(f!)).toContain('[INFO]');
    expect(formatFinding(f!)).toContain('LINT-005');
  });
});
