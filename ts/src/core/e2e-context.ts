/**
 * Browser-driver (E2E) context for the vacuity scanner (#971).
 *
 * `VAC-002` at `import-inferred` fidelity asks "does this test reference any
 * symbol the file imports from first-party code". An E2E spec imports page
 * objects and helpers, then drives `page` / `browser` / `driver`: its target is
 * the application, reached over the wire, so the answer is "no" by
 * construction and says nothing about vacuity. On one Playwright suite that
 * produced 70 false positives across 128 tests, burying 10 real no-assertion
 * findings.
 *
 * Evidence is static and deliberately NOT the file path: `*.spec.ts` is also a
 * vitest convention, so a name proves nothing. Two signals count:
 *
 * - primary, per file: an import or require of a browser-driver package;
 * - secondary, per test: a `page` / `browser` / `driver` fixture destructured in
 *   the test callback's signature (the Playwright fixture shape), for specs that
 *   import `test` from a local fixtures module instead of the package.
 *
 * The finding is diverted to `skipped` with a named reason, never dropped: a
 * suppressed inference and a passing check must not look alike (#705).
 */

import type { SkipEntry } from './gate-result.js';

const E2E_SKIP_REASON = 'E2E context, target is the application';

/** `@playwright/test`, `playwright`, `@wdio/*`, `cypress`, `selenium-webdriver`, `appwright`. */
const DRIVER_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](?:@playwright\/test|playwright|@wdio\/[^'"]+|cypress|selenium-webdriver|appwright)['"]/;

/** `async ({ page }) =>`, `({ browser, context }) =>`, `function ({ driver })`. */
const DRIVER_FIXTURE = /\(\s*\{[^}]*\b(?:page|browser|driver)\b[^}]*\}/;

/** True when the file imports a browser-driver package. */
export function importsBrowserDriver(source: string): boolean {
  return DRIVER_IMPORT.test(source);
}

/** True when a test declaration line destructures a driver fixture. */
export function declaresDriverFixture(declaration: string): boolean {
  return DRIVER_FIXTURE.test(declaration);
}

interface DivertableFinding {
  rule: string;
  fidelity?: string;
}

/**
 * Move import-inferred `VAC-002` findings out of `findings` and into `skipped`
 * when the test runs in an E2E context. Every other finding passes through.
 */
export function divertE2EInferred<F extends DivertableFinding>(
  findings: F[],
  e2e: boolean,
  skipLabel: string,
  skipped: SkipEntry[],
): F[] {
  if (!e2e) return findings;
  const kept = findings.filter(
    (f) => !(f.rule === 'VAC-002' && f.fidelity === 'import-inferred'),
  );
  if (kept.length < findings.length)
    skipped.push({ name: skipLabel, reason: E2E_SKIP_REASON });
  return kept;
}
