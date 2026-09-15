/**
 * #929 — the advisory `weak-test` finding flagged correct tests on real PRs.
 *
 * Three defects, each pinned by the real diff shape that exposed it:
 *   1. a test block cut off by the diff was scored over its visible half, so an
 *      `expect` below the context read as "asserts nothing" (#798, #916);
 *   2. an assertion routed through a helper defined in the same file was not
 *      recognised (#863), nor was an `assert*(` call in JS/TS;
 *   3. the finding named no test and no line, so no reviewer could check it.
 *
 * The last block is the anti-regression guard: a fix that turned the detector
 * off would pass the first three and fail it.
 */

import { describe, expect, it } from 'vitest';

import { type ChangedUnit } from '../src/guardian/coverage.js';
import { filterTestUnits, scopeDiff } from '../src/guardian/pr-check.js';
import { buildWeakTestFindings } from '../src/guardian/weak-test.js';

function weak(diff: string) {
  const [, units]: [unknown, ChangedUnit[]] = filterTestUnits(scopeDiff(diff));
  return buildWeakTestFindings(units, diff);
}

// #798, ts/test/migrator.test.ts: a one-line value rename inside an existing
// test; the block's `expect` sits below the visible context.
const DIFF_798_RENAME = `diff --git a/ts/test/migrator.test.ts b/ts/test/migrator.test.ts
index c69e0bb5..a1420abc 100644
--- a/ts/test/migrator.test.ts
+++ b/ts/test/migrator.test.ts
@@ -586,11 +586,11 @@ describe('TestWorkspaceExistingSuiteScan', () => {

   it('reads the workspaces.packages object form', () =>
     withTmp((root) => {
-      harnessProject(root, { version: 1, name: 'capwell' });
+      harnessProject(root, { version: 1, name: 'acme' });
       write(
         join(root, 'package.json'),
         JSON.stringify({
-          name: 'capwell',
+          name: 'acme',
           workspaces: { packages: ['apps/*'] },
         }),
       );
`;

// #916 hunk 8, ts/test/mcp-server.test.ts: a setup edit whose `expect` is
// below the context.
const DIFF_916_SETUP = `diff --git a/ts/test/mcp-server.test.ts b/ts/test/mcp-server.test.ts
--- a/ts/test/mcp-server.test.ts
+++ b/ts/test/mcp-server.test.ts
@@ -717,7 +855,10 @@ describe('tool wrappers delegate to their impls', () => {
   });

   it('write wrapper forwards all three args', () => {
-    const root = mkroot();
+    // The wrapper uses the server's own WORKING_DIR as the containment root,
+    // so the target has to be inside it.
+    const root = mkdtempSync(join(process.cwd(), 'canary-wrapper-'));
+    roots.push(root);
     const out = writeTestFileTool({
       file_path: join(root, 'x'),
       content: 'body',
`;

// The pytest twin of the truncated span: no dedented line is visible, so the
// block's end — and whatever assert sits there — is unknown.
const DIFF_PY_TRUNCATED = `diff --git a/tests/test_widget.py b/tests/test_widget.py
--- a/tests/test_widget.py
+++ b/tests/test_widget.py
@@ -10,3 +10,4 @@
 def test_widget_resizes():
     w = make_widget()
+    w.resize(2)
     w.refresh()
`;

// #863, ts/test/scaling-curve.test.ts (new file, trimmed): tests assert through
// a local `abstains(...)` helper.
const DIFF_863_HELPER = `diff --git a/ts/test/scaling-curve.test.ts b/ts/test/scaling-curve.test.ts
new file mode 100644
--- /dev/null
+++ b/ts/test/scaling-curve.test.ts
@@ -0,0 +1,17 @@
+describe('abstains, naming the rule', () => {
+  const abstains = (
+    points: { size: number; value: number }[],
+    rule: RegExp,
+  ) => {
+    const r = fitScaling(points);
+    if (r.verdict !== 'INSUFFICIENT_DATA') throw new Error(r.verdict);
+    expect(r.reasons.join('\\n')).toMatch(rule);
+  };
+
+  it('on fewer than 4 distinct sizes', () =>
+    abstains(curve((n) => n).slice(0, 3), /4 distinct sizes/));
+
+  it('on a size span under 8x', () =>
+    abstains(
+      [1000, 1500, 2000, 3000].map((size) => ({ size, value: size })),
+      /span/,
+    ));
+});
`;

const DIFF_ASSERT_PREFIX_TS = `diff --git a/src/widget.test.ts b/src/widget.test.ts
new file mode 100644
--- /dev/null
+++ b/src/widget.test.ts
@@ -0,0 +1,4 @@
+it('builds a valid widget', () => {
+  const w = makeWidget();
+  assertValidWidget(w);
+});
`;

// #935 shapes: an import-block edit and a fixture-constant edit in test files.
const DIFF_935_IMPORT_AND_FIXTURE = `diff --git a/ts/test/guardian-pr-comment.test.ts b/ts/test/guardian-pr-comment.test.ts
--- a/ts/test/guardian-pr-comment.test.ts
+++ b/ts/test/guardian-pr-comment.test.ts
@@ -10,6 +10,7 @@ import { describe, expect, it } from 'vitest';

 import {
   type Comment,
+  type GuardianIdentity,
   type UpsertResult,
   FakeGitHubClient,
   GitHubPermissionError,
diff --git a/ts/test/guardian-adjudication.test.ts b/ts/test/guardian-adjudication.test.ts
--- a/ts/test/guardian-adjudication.test.ts
+++ b/ts/test/guardian-adjudication.test.ts
@@ -51,6 +51,7 @@ afterEach(() => rmTmp(tmp));

 // --- fixtures -------------------------------------------------------------

+const BOT = { login: 'github-actions[bot]', type: 'Bot' };
 const up = (user: string): Reaction => ({ user, content: '+1' });
 const down = (user: string): Reaction => ({ user, content: '-1' });

`;

const DIFF_EMPTY_IT = `diff --git a/src/widget.test.ts b/src/widget.test.ts
--- a/src/widget.test.ts
+++ b/src/widget.test.ts
@@ -10,3 +10,4 @@
 describe('widget', () => {
+  it('x', () => {});
   it('y', () => {
     expect(1).toBe(1);
`;

const DIFF_NON_ASSERTING_HELPER = `diff --git a/src/widget.test.ts b/src/widget.test.ts
--- a/src/widget.test.ts
+++ b/src/widget.test.ts
@@ -1,4 +1,9 @@
 function makeWidget() {
   return { size: 1 };
 }

+it('builds a widget', () => {
+  const w = makeWidget();
+  console.log(w);
+});
+
`;

describe('#929: a block whose end is out of view is abstained on', () => {
  it('#798: a rename inside an existing it(...) is not flagged', () => {
    expect(weak(DIFF_798_RENAME)).toEqual([]);
  });

  it('#916 hunk 8: a setup edit with the expect below context is not flagged', () => {
    expect(weak(DIFF_916_SETUP)).toEqual([]);
  });

  it('pytest: a body with no visible dedent is not flagged', () => {
    expect(weak(DIFF_PY_TRUNCATED)).toEqual([]);
  });
});

describe('#929: assertions routed through helpers are recognised', () => {
  it('#863: a call to a same-file helper that asserts counts', () => {
    expect(weak(DIFF_863_HELPER)).toEqual([]);
  });

  it('an assert*-named call counts in JS/TS, as it does in pytest', () => {
    expect(weak(DIFF_ASSERT_PREFIX_TS)).toEqual([]);
  });

  it('#935: import-block and fixture-constant edits are not flagged', () => {
    expect(weak(DIFF_935_IMPORT_AND_FIXTURE)).toEqual([]);
  });
});

describe('#929: true positives still fire and name their test', () => {
  it('flags a fully visible empty it(...) with its title and line', () => {
    const findings = weak(DIFF_EMPTY_IT);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.evidence).toContain('added test "x" (L11–L11)');
    expect(findings[0]!.added_ranges).toEqual([[11, 11]]);
  });

  it('flags a test whose only calls are to non-asserting helpers', () => {
    const findings = weak(DIFF_NON_ASSERTING_HELPER);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.evidence).toContain(
      'added test "builds a widget" (L5–L8) asserts nothing',
    );
    expect(findings[0]!.added_ranges).toEqual([[5, 8]]);
  });
});
