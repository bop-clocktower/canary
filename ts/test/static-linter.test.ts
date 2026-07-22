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
