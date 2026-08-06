/**
 * #565 — test-support files must not be asked to host a test.
 *
 * #413 taught the gate that a non-source path can never satisfy a coverage
 * finding. It left a second, narrower class untouched: files that ARE the test
 * infrastructure but are identified by a *filename idiom* rather than by living
 * under a `fixtures/` directory. A pytest `conftest` and a Playwright fixture
 * module are the measured cases (a downstream consumer PR): guardian asked for a
 * test covering a test fixture, which inverts the relationship it exists to
 * check.
 *
 * Why this suppresses at EVERY tier rather than only the heuristic one: the
 * existing `**\/fixtures\/**` convention already sits in the all-tier skip
 * layer, and the reason generalises. lcov will faithfully report a Playwright
 * fixture's lines as uncovered — that datum is true, and the inference drawn
 * from it ("this needs a test") is still impossible to satisfy. A
 * coverage-verified verdict is only as good as the question it answers.
 *
 * The suppression is deliberately *component*-scoped, not substring-scoped:
 * `conftestimonial.py` is not a conftest, and must survive.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ChangedUnit,
  isTestPath,
  isTestSupportPath,
} from '../src/guardian/coverage.js';
import { filterTestSupportUnits } from '../src/guardian/pr-check.js';
import { invokeGuardian, mkTmp, rmTmp } from './guardian-cli-testkit.js';

function unit(path: string): ChangedUnit {
  return { path, added_ranges: [[1, 3]] };
}

// --- isTestSupportPath --------------------------------------------------------

describe('isTestSupportPath (#565)', () => {
  describe('pytest conftest, by name rather than by directory', () => {
    it.each([
      // The measured case: a distributable conftest template, so it carries a
      // suffix and cannot be the bare `conftest.py` pytest resolves natively.
      'scripts/otel_bootstrap/conftest_otel.py',
      'conftest.py',
      'src/pkg/conftest.py',
      'src/pkg/otel_conftest.py',
      'src/pkg/conftest-otel.py',
    ])('treats %s as test support', (path) => {
      expect(isTestSupportPath(path)).toBe(true);
    });

    it('does not fire on a word that merely starts with conftest', () => {
      // Substring matching would swallow this; component matching must not.
      expect(isTestSupportPath('src/conftestimonial.py')).toBe(false);
    });

    it('does not fire on conftest in a non-Python file', () => {
      // `conftest` is pytest's resolution rule specifically. A JS file named
      // conftest.js carries no such framework meaning.
      expect(isTestSupportPath('src/conftest.js')).toBe(false);
    });
  });

  describe('fixture modules, by basename component under any separator', () => {
    it.each([
      // The measured case: a Playwright per-test root-span fixture.
      'scripts/otel_bootstrap/playwright-fixture.ts',
      'src/helpers/fixture_helpers.py',
      'src/data/user.fixtures.ts',
      'src/benefits/mock/fixtures.ts',
      'src/support/fixture.tsx',
    ])('treats %s as test support', (path) => {
      expect(isTestSupportPath(path)).toBe(true);
    });

    it('does not fire when fixture is only part of a larger word', () => {
      expect(isTestSupportPath('src/fixtureless-parser.ts')).toBe(false);
      expect(isTestSupportPath('src/prefixtures.ts')).toBe(false);
    });
  });

  describe('ordinary source is untouched', () => {
    it.each([
      'src/app.ts',
      'src/guardian/coverage.ts',
      'scripts/otel_bootstrap/otel_types.mjs',
      'src/components/ConfirmModal/types.ts',
    ])('leaves %s alone', (path) => {
      expect(isTestSupportPath(path)).toBe(false);
    });
  });

  describe('stays independent of isTestPath', () => {
    // Widening isTestPath would make a conftest confer graph coverage on every
    // module it imports (coverage.ts reverse-BFS), turning a false positive
    // into a false negative. The two predicates must remain distinct.
    it('does not reclassify a conftest as a test file', () => {
      expect(isTestPath('scripts/otel_bootstrap/conftest_otel.py')).toBe(false);
    });

    it('does not reclassify a fixture module as a test file', () => {
      expect(isTestPath('scripts/otel_bootstrap/playwright-fixture.ts')).toBe(
        false,
      );
    });
  });
});

// --- filterTestSupportUnits ---------------------------------------------------

describe('filterTestSupportUnits (#565)', () => {
  it('partitions test-support units out of the scorable set', () => {
    const units = [
      unit('src/app.ts'),
      unit('scripts/otel_bootstrap/conftest_otel.py'),
      unit('scripts/otel_bootstrap/playwright-fixture.ts'),
      unit('src/checkout/total.ts'),
    ];

    const [kept, support] = filterTestSupportUnits(units);

    expect(kept.map((u) => u.path)).toEqual([
      'src/app.ts',
      'src/checkout/total.ts',
    ]);
    expect(support.map((u) => u.path)).toEqual([
      'scripts/otel_bootstrap/conftest_otel.py',
      'scripts/otel_bootstrap/playwright-fixture.ts',
    ]);
  });

  it('keeps every unit when none is test support', () => {
    const units = [unit('src/app.ts'), unit('src/checkout/total.ts')];

    const [kept, support] = filterTestSupportUnits(units);

    expect(kept).toEqual(units);
    expect(support).toEqual([]);
  });

  it('preserves input order in both partitions', () => {
    const units = [
      unit('b/fixtures.ts'),
      unit('a/app.ts'),
      unit('a/conftest.py'),
      unit('b/app.ts'),
    ];

    const [kept, support] = filterTestSupportUnits(units);

    expect(kept.map((u) => u.path)).toEqual(['a/app.ts', 'b/app.ts']);
    expect(support.map((u) => u.path)).toEqual([
      'b/fixtures.ts',
      'a/conftest.py',
    ]);
  });
});

// --- CLI wiring ---------------------------------------------------------------

// Reproduces the two findings measured on a downstream consumer PR: a pytest
// conftest template and a Playwright fixture, both under a plain `scripts/`
// directory alongside one genuinely untested module.
const DIFF_SUPPORT_AND_SRC = `diff --git a/scripts/otel_bootstrap/conftest_otel.py b/scripts/otel_bootstrap/conftest_otel.py
index 1111111..2222222 100644
--- a/scripts/otel_bootstrap/conftest_otel.py
+++ b/scripts/otel_bootstrap/conftest_otel.py
@@ -0,0 +1,3 @@
+def pytest_configure(config):
+    provider = TracerProvider()
+    return provider
diff --git a/scripts/otel_bootstrap/playwright-fixture.ts b/scripts/otel_bootstrap/playwright-fixture.ts
index 3333333..4444444 100644
--- a/scripts/otel_bootstrap/playwright-fixture.ts
+++ b/scripts/otel_bootstrap/playwright-fixture.ts
@@ -0,0 +1,3 @@
+export const test = withTestSpan(base);
+export function withTestSpan(t) {
+  return t;
+}
diff --git a/src/widget.ts b/src/widget.ts
index 5555555..6666666 100644
--- a/src/widget.ts
+++ b/src/widget.ts
@@ -0,0 +1,3 @@
+export function widget() {
+  return 42;
+}
`;

const DIFF_SUPPORT_ONLY = DIFF_SUPPORT_AND_SRC.split('diff --git a/src')[0]!;

describe('pr-check test-support suppression (#565)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkTmp();
    mkdirSync(join(tmp, 'src'), { recursive: true });
    mkdirSync(join(tmp, 'scripts', 'otel_bootstrap'), { recursive: true });
    writeFileSync(
      join(tmp, 'src', 'widget.ts'),
      'export function widget() {\n  return 42;\n}\n',
      'utf-8',
    );
    writeFileSync(
      join(tmp, 'scripts', 'otel_bootstrap', 'conftest_otel.py'),
      'def pytest_configure(config):\n    return None\n',
      'utf-8',
    );
    writeFileSync(
      join(tmp, 'scripts', 'otel_bootstrap', 'playwright-fixture.ts'),
      'export const test = withTestSpan(base);\n',
      'utf-8',
    );
  });
  afterEach(() => {
    rmTmp(tmp);
  });

  it('flags the real module but neither test-support file', async () => {
    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--format', 'json'],
      { input: DIFF_SUPPORT_AND_SRC, cwd: tmp },
    );

    const paths = JSON.parse(res.stdout).findings.map(
      (f: { path: string }) => f.path,
    );
    expect(paths).toContain('src/widget.ts');
    expect(paths).not.toContain('scripts/otel_bootstrap/conftest_otel.py');
    expect(paths).not.toContain('scripts/otel_bootstrap/playwright-fixture.ts');
  });

  it('abstains rather than reporting a clean pass on a support-only diff', async () => {
    // The false-green guard. Suppressing the findings must NOT turn into
    // "✅ no issues found" + exit 0 — nothing was judged, so the honest answer
    // is an abstention naming both skipped paths.
    const res = await invokeGuardian(['pr-check', '--diff', '-'], {
      input: DIFF_SUPPORT_ONLY,
      cwd: tmp,
    });

    expect(res.code).toBe(3);
    expect(res.stdout.toLowerCase()).toContain('abstained');
    expect(res.stdout).toContain('(2 skipped');
  });

  it('never proposes authoring a test FOR a test-support file', async () => {
    // The authoring surface (`author-plan`) reads its own gap list, so the
    // suppression has to hold there too. A generated "test for the fixture" is
    // the same inversion as the finding, except it also writes a file.
    const res = await invokeGuardian(['author-plan', '--diff', '-', '--json'], {
      input: DIFF_SUPPORT_AND_SRC,
      cwd: tmp,
    });

    const plan = JSON.parse(res.stdout);
    const planned = JSON.stringify(plan);
    expect(planned).not.toContain('conftest_otel');
    expect(planned).not.toContain('playwright-fixture');
  });

  it('names every suppressed path in the abstention line', async () => {
    // Suppression must stay auditable: an adopter who sees "0 checked" has to
    // be able to read WHICH paths were dropped, or the gate has quietly
    // shrunk its own denominator. (The per-entry `reason` we attach is not yet
    // rendered on this surface — see the note in prCheckSkipEntries.)
    const res = await invokeGuardian(['pr-check', '--diff', '-'], {
      input: DIFF_SUPPORT_ONLY,
      cwd: tmp,
    });

    expect(res.stdout).toContain('scripts/otel_bootstrap/conftest_otel.py');
    expect(res.stdout).toContain(
      'scripts/otel_bootstrap/playwright-fixture.ts',
    );
  });
});
