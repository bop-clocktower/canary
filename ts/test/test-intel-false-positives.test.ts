/**
 * canary's test-intelligence tools, run on canary's own tests (#1751, #1365).
 *
 * A harness-audit ran `review-test` and `vacuity-check` over this repo and
 * found shapes that fire on correct code often enough that a reader learns to
 * skip the output. Each block below pins one of those shapes as a regression,
 * and pairs it with the true positive the fix must keep. A fix that silences
 * the real finding is worse than the false positive it removed.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { StaticLinter, type LintFinding } from '../src/core/static-linter.js';
import { scanVacuity } from '../src/core/vacuity-scanner.js';
import { makeProject, type TempProject } from './scanner-testkit.js';

let project: TempProject | null = null;
afterEach(() => {
  project?.cleanup();
  project = null;
});

function lint(name: string, content: string): LintFinding[] {
  project = makeProject({ [name]: content });
  return new StaticLinter().lint(`${project.root}/${name}`);
}

function rulesAt(findings: LintFinding[], rule: string): number[] {
  return findings.filter((f) => f.rule === rule).map((f) => f.line);
}

function vacuity(files: Record<string, string>, name: string) {
  project = makeProject(files);
  return scanVacuity(`${project.root}/${name}`);
}

function vac002(r: ReturnType<typeof scanVacuity>): string[] {
  return r.findings.filter((f) => f.rule === 'VAC-002').map((f) => f.test);
}

describe('review-test selector rules read only a locator call argument', () => {
  it('ignores a selector inside a string that is itself the test input', () => {
    const findings = lint(
      'a.spec.ts',
      [
        `it('heals', () => {`,
        `  expect(f("page.locator('.btn')")).toBe(1);`,
        `  expect(g('await page.locator("#id").click();')).toBe(1);`,
        `  expect(h("page.locator('//div[@id]')")).toBe(1);`,
        `});`,
      ].join('\n'),
    );
    expect(rulesAt(findings, 'LINT-001')).toEqual([]);
    expect(rulesAt(findings, 'LINT-002')).toEqual([]);
    expect(rulesAt(findings, 'LINT-003')).toEqual([]);
  });

  it('still flags a brittle selector passed straight to a locator call', () => {
    const findings = lint(
      'b.spec.ts',
      [
        `test('x', async ({ page }) => {`,
        `  await page.locator('.btn').click();`,
        `  await page.locator("#submit").click();`,
        `  await page.locator('//div[@id]').click();`,
        `  await page.locator( '.spaced' ).click();`,
        `  expect(1).toBe(1);`,
        `});`,
      ].join('\n'),
    );
    expect(rulesAt(findings, 'LINT-001')).toEqual([2, 5]);
    expect(rulesAt(findings, 'LINT-002')).toEqual([3]);
    expect(rulesAt(findings, 'LINT-003')).toEqual([4]);
  });

  it('does not tell a DOM-emulation unit test to use getByRole for querySelector', () => {
    const findings = lint(
      'panel.test.ts',
      [
        // Split so vitest does not read this file's own environment pragma.
        `// @vitest-` + `environment happy-dom`,
        `it('draws', () => {`,
        `  expect(root.querySelector('.big')!.textContent).toBe('99%');`,
        `});`,
      ].join('\n'),
    );
    expect(rulesAt(findings, 'LINT-001')).toEqual([]);
  });

  it('still flags querySelector outside a DOM-emulation unit test', () => {
    const findings = lint(
      'dom.spec.ts',
      [
        `it('draws', () => {`,
        `  expect(document.querySelector('.big')).toBeTruthy();`,
        `});`,
      ].join('\n'),
    );
    expect(rulesAt(findings, 'LINT-001')).toEqual([2]);
  });

  it('still flags querySelector when Testing Library offers getByRole', () => {
    const findings = lint(
      'tl.test.ts',
      [
        `// @vitest-` + `environment jsdom`,
        `import { screen } from '@testing-library/dom';`,
        `it('draws', () => {`,
        `  expect(document.querySelector('.big')).toBeTruthy();`,
        `});`,
      ].join('\n'),
    );
    expect(rulesAt(findings, 'LINT-001')).toEqual([4]);
  });
});

describe('review-test LINT-006 follows a same-file assertion helper', () => {
  it('credits a test whose only statement calls a helper that asserts', () => {
    const findings = lint(
      'c.test.ts',
      [
        `describe('abstains', () => {`,
        `  const abstains = (n: number, rule: RegExp) => {`,
        `    const r = fit(n);`,
        `    expect(r.reasons.join('\\n')).toMatch(rule);`,
        `  };`,
        `  it('on few sizes', () =>`,
        `    abstains(3, /4 distinct sizes/));`,
        `  it('on a poor fit', () => abstains(4, /R2/));`,
        `});`,
        `function check(v: number) {`,
        `  expect(v).toBeGreaterThan(0);`,
        `}`,
        `it('via a function helper', () => { check(1); });`,
      ].join('\n'),
    );
    expect(rulesAt(findings, 'LINT-006')).toEqual([]);
  });

  it('bounds a semicolon-free helper at the next declaration', () => {
    // No `;` and no continuation: the helper's body ends where the next
    // declaration begins, so `noop` does not inherit `check`'s expect.
    const findings = lint(
      'e.test.ts',
      [
        `const check = (v: number) => expect(v).toBe(1)`,
        `const noop = (v: number) => v`,
        `it('checks', () => check(1))`,
        `it('only runs', () => noop(1))`,
      ].join('\n'),
    );
    expect(rulesAt(findings, 'LINT-006')).toEqual([4]);
  });

  it('still flags a test whose helper never asserts', () => {
    const findings = lint(
      'd.test.ts',
      [
        `const run = (n: number) => {`,
        `  fit(n);`,
        `};`,
        `it('runs', () => run(3));`,
        `it('asserts', () => { expect(fit(1)).toBe(1); });`,
      ].join('\n'),
    );
    expect(rulesAt(findings, 'LINT-006')).toEqual([4]);
  });
});

describe('cassandra VAC-002 binds a dynamic import of a script handle (#1365)', () => {
  const HEAD = [
    `import { join } from 'node:path';`,
    `import { pathToFileURL } from 'node:url';`,
    `import { runCapture } from './subprocess-testkit.js';`,
    `const SCRIPT_URL = pathToFileURL(`,
    `  join(__dirname, '..', 'scripts', 'install-siren.mjs'),`,
    `).href;`,
  ].join('\n');

  it('credits a target destructured from `(await import(SCRIPT_URL))`', () => {
    const src = [
      HEAD,
      `const {`,
      `  schedulerStatus,`,
      `  LABEL,`,
      `} = (await import(SCRIPT_URL)) as SirenModule;`,
      `const status = (a: object) => schedulerStatus(a) as Status;`,
      `it('reports dark', () => { expect(status({}).ok).toBe(false); });`,
      `it('names the label', () => { expect(LABEL).toMatch(/siren/); });`,
      `it('never calls it', () => { expect(1 + 1).toBe(2); });`,
    ].join('\n');
    const r = vacuity({ 'a.test.ts': src }, 'a.test.ts');
    expect(vac002(r)).toEqual(['never calls it']);
  });

  it('credits a module assigned from `await import(LIB)` and `import(pathToFileURL(SCRIPT).href)`', () => {
    const src = [
      `import { join } from 'node:path';`,
      `import { pathToFileURL } from 'node:url';`,
      `const LIB = pathToFileURL(join(ROOT, 'lib', 'route-labels.mjs')).href;`,
      `const SCRIPT = join(ROOT, 'scripts', 'schedule.mjs');`,
      `const lib = (await import(LIB)) as RouteLabelsModule;`,
      `const mod = (await import(pathToFileURL(SCRIPT).href)) as Module;`,
      `let late: Module;`,
      `beforeAll(async () => { late = await import(LIB); });`,
      `it('routes', () => { expect(lib.route('x')).toBe('adr'); });`,
      `it('schedules', () => { expect(mod.stale(1)).toBe(false); });`,
      `it('late-bound', () => { expect(late.route('y')).toBe('pr'); });`,
      `it('never calls it', () => { expect([1].length).toBe(1); });`,
    ].join('\n');
    const r = vacuity({ 'b.test.ts': src }, 'b.test.ts');
    expect(vac002(r)).toEqual(['never calls it']);
  });

  it('does not treat an import of a non-script handle as first-party', () => {
    const src = [
      `import { save } from './store.js';`,
      `const NAME = 'node:fs';`,
      `const fsMod = await import(NAME);`,
      `it('reads fs only', () => { expect(fsMod.existsSync('x')).toBe(false); });`,
      `it('saves', () => { expect(save(1)).toBe(1); });`,
    ].join('\n');
    const r = vacuity({ 'c.test.ts': src }, 'c.test.ts');
    expect(vac002(r)).toEqual(['reads fs only']);
  });
});

describe('cassandra VAC-002 abstains when the only first-party import is a testkit', () => {
  it('records a named skip instead of 20 findings on a workflow-lint suite', () => {
    const src = [
      `import { load } from 'js-yaml';`,
      `import { advisoryEntries } from './required-checks-testkit.js';`,
      `it('checks out base only', () => {`,
      `  expect(load(WORKFLOW).jobs.scan.steps[0].with).toBeUndefined();`,
      `});`,
      `it('lists the advisory entries', () => {`,
      `  expect(advisoryEntries()).toContain('x');`,
      `});`,
    ].join('\n');
    const r = vacuity({ 'leak.test.ts': src }, 'leak.test.ts');
    expect(vac002(r)).toEqual([]);
    expect(r.checked).toBe(2);
    // Only the YAML-only test had a finding to divert; it is named, not dropped.
    const kit = r.skipped?.filter((s) => /testkit/.test(s.reason)) ?? [];
    expect(kit.map((s) => s.name)).toEqual([
      expect.stringContaining('checks out base only'),
    ]);
  });

  it('still infers from a real module imported alongside a testkit', () => {
    const src = [
      `import { advisoryEntries } from './required-checks-testkit.js';`,
      `import { save } from '../src/store.js';`,
      `it('saves', () => { expect(save(1)).toBe(1); });`,
      `it('reads yaml only', () => { expect(load(Y)).toBeTruthy(); });`,
    ].join('\n');
    const r = vacuity({ 'mixed.test.ts': src }, 'mixed.test.ts');
    expect(vac002(r)).toEqual(['reads yaml only']);
  });
});

describe('cassandra VAC-002 follows a namespace import through describe.each', () => {
  const SRC = [
    `import * as blackhawkCopy from '../a/string-literals.mjs';`,
    `import * as savantCopy from '../b/string-literals.mjs';`,
    `describe.each([`,
    `  ['canary-blackhawk copy', blackhawkCopy],`,
    `  ['canary-savant copy', savantCopy],`,
    `])('%s', (_name, mod) => {`,
    `  const { stringLiteralRanges, inStringLiteral } = mod as {`,
    `    stringLiteralRanges: (line: string) => Array<[number, number]>;`,
    `    inStringLiteral: (r: Array<[number, number]>, i: number) => boolean;`,
    `  };`,
    `  const ranges = (line: string) => {`,
    `    return stringLiteralRanges(line);`,
    `  };`,
    `  it('returns no ranges for a quote-free line', () => {`,
    `    expect(ranges('abc')).toEqual([]);`,
    `  });`,
    `  it('checks membership', () => {`,
    `    expect(inStringLiteral([[0, 1]], 0)).toBe(true);`,
    `  });`,
    `  it('only reads the label', () => {`,
    `    expect(_name.length).toBeGreaterThan(0);`,
    `  });`,
    `});`,
  ].join('\n');

  it('credits a test reaching the module through the each parameter', () => {
    const r = vacuity({ 'sl.test.ts': SRC }, 'sl.test.ts');
    expect(vac002(r)).toEqual(['only reads the label']);
  });
});
