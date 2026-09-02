/**
 * #747 — the "added test asserts nothing" heuristic must judge the ENCLOSING
 * test block, not the changed hunk.
 *
 * The measured false positive: a diff that touches only a test's arrange/act
 * lines was reported as an assertion-free test because the `expect(...)` sat
 * one line past the last `+` line. Edits to a test's setup are far more common
 * than edits to its assertion, so this class was every finding in the run that
 * produced the report.
 *
 * The second half of this suite is the anti-regression guard: a fix that simply
 * turned the detector off would pass the FP cases and fail these.
 */

import { describe, expect, it } from 'vitest';

import { type ChangedUnit } from '../src/guardian/coverage.js';
import {
  buildWeakTestFindings,
  filterTestUnits,
  scopeDiff,
} from '../src/guardian/pr-check.js';

function testUnits(diff: string): ChangedUnit[] {
  const [, units] = filterTestUnits(scopeDiff(diff));
  return units;
}

// The repro from #747: the title is retitled (so the `it(` signature IS an
// added line, which is what makes the scorer see a test at all) and the act
// lines move, while the assertion below them stays context. Scored over the
// added lines alone, that reads as "a test with zero assertions".
const DIFF_ACT_ONLY = `diff --git a/src/DonationsSection.web.test.tsx b/src/DonationsSection.web.test.tsx
--- a/src/DonationsSection.web.test.tsx
+++ b/src/DonationsSection.web.test.tsx
@@ -35,8 +35,9 @@ describe('DonationsSection', () => {
-  it('calls onSeeAll', () => {
+  it('calls onSeeAll when See all is clicked', () => {
     const onSeeAll = vi.fn();
     render(<DonationsSection items={[]} onSeeAll={onSeeAll} />);
+    fireEvent.click(
+      screen.getByRole('button', { name: 'seeAllA11yLabel' }),
+    );
     expect(onSeeAll).toHaveBeenCalledTimes(1);
   });
 });
`;

// Same shape in pytest: the test is renamed and an act line is added, while
// the `assert` one line below stays put.
const DIFF_ACT_ONLY_PY = `diff --git a/tests/test_widget.py b/tests/test_widget.py
--- a/tests/test_widget.py
+++ b/tests/test_widget.py
@@ -10,3 +10,4 @@
-def test_widget():
+def test_widget_resizes():
     w = make_widget()
+    w.resize(2)
     assert w.size == 2
`;

// A Playwright auth fixture. It is test *infrastructure*, not a test, and #565
// already stopped asking fixtures to HAVE tests. The enclosing-block rule
// inherits that for free: a `setup(...)` callback is not a test block, so there
// is nothing to judge assertion presence over and the heuristic abstains.
const DIFF_SETUP_FIXTURE = `diff --git a/tests/auth.setup.ts b/tests/auth.setup.ts
--- a/tests/auth.setup.ts
+++ b/tests/auth.setup.ts
@@ -1,4 +1,6 @@
 setup('authenticate', async ({ page }) => {
+  await page.goto('/login');
+  await page.fill('#email', credentials.email);
   await page.context().storageState({ path: authFile });
 });
`;

// The detector must still fire here: the whole enclosing block is visible and
// it contains no assertion at all.
const DIFF_TRULY_WEAK = `diff --git a/src/DonationsSection.web.test.tsx b/src/DonationsSection.web.test.tsx
--- a/src/DonationsSection.web.test.tsx
+++ b/src/DonationsSection.web.test.tsx
@@ -35,4 +35,8 @@ describe('DonationsSection', () => {
   it('renders the empty state', () => {
     render(<DonationsSection items={[]} />);
+    fireEvent.click(
+      screen.getByRole('button'),
+    );
+    console.log('clicked');
   });
 });
`;

const DIFF_TRULY_WEAK_PY = `diff --git a/tests/test_widget.py b/tests/test_widget.py
--- a/tests/test_widget.py
+++ b/tests/test_widget.py
@@ -10,3 +10,4 @@
 def test_widget_resizes():
     w = make_widget()
+    print(w.size)

`;

describe('weak-test findings judge the enclosing block (#747)', () => {
  it('does not flag an act-only hunk whose assertion is a context line', () => {
    expect(
      buildWeakTestFindings(testUnits(DIFF_ACT_ONLY), DIFF_ACT_ONLY),
    ).toEqual([]);
  });

  it('does not flag an act-only pytest hunk with the assert below it', () => {
    expect(
      buildWeakTestFindings(testUnits(DIFF_ACT_ONLY_PY), DIFF_ACT_ONLY_PY),
    ).toEqual([]);
  });

  it('does not flag a Playwright setup fixture', () => {
    expect(
      buildWeakTestFindings(testUnits(DIFF_SETUP_FIXTURE), DIFF_SETUP_FIXTURE),
    ).toEqual([]);
  });
});

describe('the detector is still on (#747 anti-regression)', () => {
  it('flags an added block that genuinely asserts nothing', () => {
    const findings = buildWeakTestFindings(
      testUnits(DIFF_TRULY_WEAK),
      DIFF_TRULY_WEAK,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe('weak-test');
    expect(findings[0]!.path).toBe('src/DonationsSection.web.test.tsx');
  });

  it('flags an added pytest body that genuinely asserts nothing', () => {
    const findings = buildWeakTestFindings(
      testUnits(DIFF_TRULY_WEAK_PY),
      DIFF_TRULY_WEAK_PY,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.path).toBe('tests/test_widget.py');
  });
});
