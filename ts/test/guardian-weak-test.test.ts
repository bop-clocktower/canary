/**
 * Faithful TypeScript port of `tests/unit/test_guardian_weak_test.py`.
 *
 * An added test that asserts nothing sails through the guardian today (it only
 * flags ABSENT tests). `buildWeakTestFindings` emits an advisory `weak-test`
 * finding for such additions — never gating (see `computeExitCode`). The Typer
 * CLI end-to-end cases are DEFERRED to the later CLI wave and re-expressed here
 * against the library functions directly.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type ChangedUnit } from '../src/guardian/coverage.js';
import {
  GuardianConfig,
  buildWeakTestFindings,
  computeExitCode,
  filterTestUnits,
  loadGuardianConfig,
  scopeDiff,
} from '../src/guardian/pr-check.js';

const DIFF_WEAK_PY = `diff --git a/tests/test_widget.py b/tests/test_widget.py
new file mode 100644
--- /dev/null
+++ b/tests/test_widget.py
@@ -0,0 +1,3 @@
+def test_widget():
+    w = make_widget()
+    print(w)
`;

const DIFF_STRONG_PY = `diff --git a/tests/test_widget.py b/tests/test_widget.py
new file mode 100644
--- /dev/null
+++ b/tests/test_widget.py
@@ -0,0 +1,3 @@
+def test_widget():
+    w = make_widget()
+    assert w.size == 1
`;

const DIFF_WEAK_TS = `diff --git a/src/widget.test.ts b/src/widget.test.ts
new file mode 100644
--- /dev/null
+++ b/src/widget.test.ts
@@ -0,0 +1,3 @@
+it('builds a widget', () => {
+  const w = makeWidget()
+  console.log(w)
+})
`;

const DIFF_EXPECT_HELPER_TS = `diff --git a/apps/web-e2e/routes.spec.ts b/apps/web-e2e/routes.spec.ts
new file mode 100644
--- /dev/null
+++ b/apps/web-e2e/routes.spec.ts
@@ -0,0 +1,4 @@
+test('/app/benefits/[id] renders @smoke', async ({ page }) => {
+  await gotoAppRoute(page, '/app/benefits/1')
+  await expectRouteTestId(page, 'benefit-detail-not-found')
+})
`;

// FP-3: a rename adds only the signature; the asserting body is context (not a
// `+` line). Must NOT be flagged — there's no added body to judge.
const DIFF_RENAME_ONLY = `diff --git a/tests/test_widget.py b/tests/test_widget.py
--- a/tests/test_widget.py
+++ b/tests/test_widget.py
@@ -1,3 +1,3 @@
+def test_widget_renamed():
-def test_widget():
     w = make_widget()
     assert w.size == 1
`;

function testUnits(diff: string): ChangedUnit[] {
  const [, units] = filterTestUnits(scopeDiff(diff));
  return units;
}

describe('buildWeakTestFindings', () => {
  it('flags an assertion-free python test', () => {
    const findings = buildWeakTestFindings(
      testUnits(DIFF_WEAK_PY),
      DIFF_WEAK_PY,
    );
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.kind).toBe('weak-test');
    expect(f.path).toBe('tests/test_widget.py');
    expect(f.evidence).toBeTruthy(); // explains why
  });

  it('does not flag a test with an assertion', () => {
    const findings = buildWeakTestFindings(
      testUnits(DIFF_STRONG_PY),
      DIFF_STRONG_PY,
    );
    expect(findings).toEqual([]);
  });

  it('flags an assertion-free typescript test', () => {
    const findings = buildWeakTestFindings(
      testUnits(DIFF_WEAK_TS),
      DIFF_WEAK_TS,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.path).toBe('src/widget.test.ts');
  });

  it('rename-only diff is not flagged (FP-3)', () => {
    const findings = buildWeakTestFindings(
      testUnits(DIFF_RENAME_ONLY),
      DIFF_RENAME_ONLY,
    );
    expect(findings).toEqual([]);
  });

  // #738, reported from a downstream Playwright suite: the added lines carry no
  // literal `expect(`, only calls to `expectRouteTestId` / `gotoAppRoute`, which
  // between them hold four assertions. The test was verified falsifiable by
  // running it against a wrong route. Every added spec in that suite drew a
  // finding, and the whole suite routes its assertions through those helpers on
  // purpose, so the finding would have fired forever.
  it('does not flag a test whose checks go through an expect* helper', () => {
    const findings = buildWeakTestFindings(
      testUnits(DIFF_EXPECT_HELPER_TS),
      DIFF_EXPECT_HELPER_TS,
    );
    expect(findings).toEqual([]);
  });

  it('weak findings never gate, even hard', () => {
    const findings = buildWeakTestFindings(
      testUnits(DIFF_WEAK_PY),
      DIFF_WEAK_PY,
    );
    expect(computeExitCode(findings, 'hard')).toBe(0);
  });
});

describe('weakTests config toggle', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'canary-weak-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(obj: unknown): string {
    const cfg = join(dir, 'harness.config.json');
    writeFileSync(cfg, JSON.stringify(obj), 'utf-8');
    return cfg;
  }

  it('default enabled', () => {
    expect(new GuardianConfig().weak_tests).toBe(true);
  });

  it('config can disable', () => {
    const cfg = write({ canary: { guardian: { pr: { weakTests: false } } } });
    const [config] = loadGuardianConfig(cfg);
    expect(config.weak_tests).toBe(false);
  });

  it('config omitted keeps default', () => {
    const cfg = write({ canary: { guardian: { pr: { enabled: true } } } });
    const [config] = loadGuardianConfig(cfg);
    expect(config.weak_tests).toBe(true);
  });
});
