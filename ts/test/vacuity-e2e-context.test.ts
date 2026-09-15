/**
 * #971 -- VAC-002 import-inference in a browser-driver (E2E) context.
 *
 * A Playwright/WebDriver spec imports first-party page objects and helpers and
 * then drives `page`/`browser`/`driver`. Its target is the APPLICATION, reached
 * over the wire, so "references none of the file's first-party imports" is true
 * by construction and says nothing about vacuity. On one E2E suite that shape
 * produced 70 false positives across 128 tests, burying 10 real no-assertion
 * findings.
 *
 * The fix is skip-and-disclose, not silence: an import-inferred VAC-002 in an
 * E2E context lands in `skipped` with a named reason, so the abstention stays
 * countable. Everything else about VAC-002 -- `@covers`-annotated findings and
 * unit-test files -- is unchanged, and pinned here.
 *
 * Fixtures are synthetic.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { scanVacuity } from '../src/core/vacuity-scanner.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';
import { makeProject, type TempProject } from './scanner-testkit.js';

const E2E_REASON = 'E2E context, target is the application';

let project: TempProject | null = null;
afterEach(() => {
  project?.cleanup();
  project = null;
});

function scan(name: string, content: string) {
  project = makeProject({ [name]: content });
  return scanVacuity(`${project.root}/${name}`);
}

const PLAYWRIGHT_SPEC = [
  `import { test, expect } from '@playwright/test';`,
  `import { LoginPage } from './pages/login-page.js';`,
  `test('checkout shows the order total', async ({ page }) => {`,
  `  await page.goto('/checkout');`,
  `  await expect(page.getByTestId('total')).toHaveText('$42.00');`,
  `});`,
  ``,
].join('\n');

const vac002 = (r: ReturnType<typeof scanVacuity>) =>
  r.findings.filter((f) => f.rule === 'VAC-002');

describe('VAC-002 in an E2E context (#971)', () => {
  it('skips an import-inferred VAC-002 in a Playwright spec, with the E2E reason', () => {
    const r = scan('tests/e2e/checkout.spec.ts', PLAYWRIGHT_SPEC);
    expect(r.checked).toBe(1);
    expect(vac002(r)).toEqual([]);
    const e2e = (r.skipped ?? []).filter((s) => s.reason === E2E_REASON);
    expect(e2e).toHaveLength(1);
    expect(e2e[0]!.name).toMatch(/checkout\.spec\.ts:3 VAC-002 /);
  });

  it.each([
    ['playwright', `import { chromium } from 'playwright';`],
    ['@wdio/*', `import { browser } from '@wdio/globals';`],
    ['cypress', `import 'cypress';`],
    [
      'selenium-webdriver',
      `const { Builder } = require('selenium-webdriver');`,
    ],
    ['appwright', `import { test } from 'appwright';`],
  ])('detects the %s import as E2E evidence', (_label, driverImport) => {
    const spec = [
      driverImport,
      `import { LoginPage } from './pages/login-page.js';`,
      `it('signs in', async () => {`,
      `  await go('/login');`,
      `  expect(await title()).toBe('Home');`,
      `});`,
      ``,
    ].join('\n');
    const r = scan('tests/e2e/login.spec.ts', spec);
    expect(vac002(r)).toEqual([]);
    expect((r.skipped ?? []).map((s) => s.reason)).toContain(E2E_REASON);
  });

  it('treats a page/browser/driver fixture in the test signature as E2E evidence', () => {
    const spec = [
      `import { test } from './fixtures.js';`,
      `import { LoginPage } from './pages/login-page.js';`,
      `test('signs in', async ({ browser }) => {`,
      `  const tab = await browser.newPage();`,
      `  assert.equal(await tab.title(), 'Home');`,
      `});`,
      ``,
    ].join('\n');
    const r = scan('tests/e2e/login.spec.ts', spec);
    expect(vac002(r)).toEqual([]);
    expect((r.skipped ?? []).map((s) => s.reason)).toContain(E2E_REASON);
  });

  it('(a) still reports VAC-002 on a vitest unit file of the same shape, even named *.spec.ts', () => {
    const unit = [
      `import { it, expect } from 'vitest';`,
      `import { save } from './store.js';`,
      `it('does something else', () => {`,
      `  const page = 1;`,
      `  expect(page).toBe(1);`,
      `});`,
      ``,
    ].join('\n');
    const r = scan('tests/unit/store.spec.ts', unit);
    expect(vac002(r)).toHaveLength(1);
    expect(vac002(r)[0]!.fidelity).toBe('import-inferred');
    expect((r.skipped ?? []).map((s) => s.reason)).not.toContain(E2E_REASON);
  });

  it('keeps an annotated VAC-002 in a Playwright spec', () => {
    const spec = [
      `import { test, expect } from '@playwright/test';`,
      `import { LoginPage } from './pages/login-page.js';`,
      `// @covers LoginPage`,
      `test('signs in', async ({ page }) => {`,
      `  await page.goto('/login');`,
      `  await expect(page).toHaveURL('/home');`,
      `});`,
      ``,
    ].join('\n');
    const r = scan('tests/e2e/login.spec.ts', spec);
    expect(vac002(r)).toHaveLength(1);
    expect(vac002(r)[0]!.fidelity).toBe('annotated');
  });

  it('(b) leaves the no-assertion skip on a Playwright test that asserts nothing', () => {
    const spec = [
      `import { test } from '@playwright/test';`,
      `import { LoginPage } from './pages/login-page.js';`,
      `test('logs the banner', async ({ page }) => {`,
      `  const banner = await page.textContent('.banner');`,
      `  if (banner) console.log(banner);`,
      `});`,
      ``,
    ].join('\n');
    const r = scan('tests/e2e/banner.spec.ts', spec);
    const reasons = (r.skipped ?? []).map((s) => s.reason);
    expect(reasons.some((s) => /no recognised assertion/.test(s))).toBe(true);
    expect(reasons).toContain(E2E_REASON);
  });

  it('(c) carries the skip count and reason on the CLI summary line and in --json', async () => {
    const home = mkTmp();
    try {
      const dir = join(home, 'tests', 'e2e');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'checkout.spec.ts'), PLAYWRIGHT_SPEC, 'utf-8');

      const text = await invokeCanary(['vacuity-check', dir]);
      expect(text.code).toBe(0);
      const summary = text.stdout.trim().split('\n').at(-1)!;
      expect(summary).toContain(
        `1 skipped: 1 test(s) [E2E context, target is the application]`,
      );
      expect(text.stdout).not.toContain('VAC-002');

      const json = await invokeCanary(['vacuity-check', dir, '--json']);
      const parsed = JSON.parse(json.stdout) as {
        findings: unknown[];
        skipped: { reason: string }[];
      };
      expect(parsed.findings).toEqual([]);
      expect(parsed.skipped.map((s) => s.reason)).toEqual([E2E_REASON]);
    } finally {
      rmTmp(home);
    }
  });
});
