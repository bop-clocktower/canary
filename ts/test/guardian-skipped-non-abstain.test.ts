/**
 * #582 -- the non-abstain surfaces must carry the skip denominator too.
 *
 * #579 fixed the ABSTAIN payload: a fully-suppressed diff now emits
 * `skipped: [{name, reason}]`. The normal path did not change, so a run that
 * checked 3 units and dropped 5 emitted a payload describing only the 3.
 * `checked: 3` is honest as far as it goes, and a consumer still cannot tell
 * "this diff had 3 source files" from "this diff had 8 and the guardian
 * declined to judge 5 of them".
 *
 * That is the #508 class one layer down: the engine knows something the output
 * never says. It is narrower than the abstain case -- the run did verify a real
 * denominator -- which is exactly why it survived three precision PRs.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SCHEMA_VERSION,
  buildAnalysisRecord,
} from '../src/guardian/analysis-emit.js';
import { invokeGuardianJson, mkTmp, rmTmp } from './guardian-cli-testkit.js';

let tmp: string;
beforeEach(() => {
  tmp = mkTmp();
});
afterEach(() => rmTmp(tmp));

// Keep this signature on its own line. Upstream harness's complexity extractor
// is line-anchored and brace-counts raw characters, so the collapsed one-line
// form is "detected" and then measured to end-of-file -- a phantom
// functionLength that fails a required check (#587, pinned in
// `harness-complexity-eof.test.ts`). Reformatting this declaration re-arms it.
const jsonPayload = (diff: string): Promise<Record<string, unknown>> =>
  invokeGuardianJson(['pr-check', '--diff', '-', '--format', 'json'], {
    input: diff,
    cwd: tmp,
  });

// A diff the guardian PARTLY judges: one ordinary source unit it keeps, and one
// test unit it drops. The mix is the point -- an all-dropped diff abstains and
// takes the (already fixed) #579 path instead.
const DIFF_MIXED = `diff --git a/pkg/widget.py b/pkg/widget.py
index 1111111..2222222 100644
--- a/pkg/widget.py
+++ b/pkg/widget.py
@@ -0,0 +1,3 @@
+def widget():
+    return 42
+
diff --git a/tests/test_helper.py b/tests/test_helper.py
index 3333333..4444444 100644
--- a/tests/test_helper.py
+++ b/tests/test_helper.py
@@ -0,0 +1,3 @@
+def test_helper():
+    assert widget() == 42
+
`;

// The all-kept control: no filter fires, so nothing is dropped.
const DIFF_CLEAN = `diff --git a/pkg/widget.py b/pkg/widget.py
index 1111111..2222222 100644
--- a/pkg/widget.py
+++ b/pkg/widget.py
@@ -0,0 +1,3 @@
+def widget():
+    return 42
+
`;

describe('non-abstain --format json carries `skipped` (#582)', () => {
  it('names the dropped path and why, alongside a real denominator', async () => {
    const data = await jsonPayload(DIFF_MIXED);

    // The run kept a real unit -- this is not the zero-ELIGIBLE-units abstain
    // path #579/#582 are about, which returns an empty `skipped`-only payload.
    // It does abstain on the COVERAGE denominator (#761: no `--coverage` here),
    // and the two are independent: `checked` and `skipped` below are what this
    // case pins, and they survive the abstention intact.
    expect(data['abstained']).toBe(true);
    expect(data['checked']).toBe(1);

    // ...and it also says what it declined to judge.
    expect(data['skipped']).toContainEqual({
      name: 'tests/test_helper.py',
      reason: 'test path',
    });
  });

  it('emits an empty list when nothing was dropped, never omits the key', async () => {
    // Omitting the key on a zero-skip run would make "nothing was skipped"
    // indistinguishable from "this producer predates #582" -- a consumer would
    // have to guess, which is the ambiguity this issue exists to remove.
    const data = await jsonPayload(DIFF_CLEAN);
    expect(data['skipped']).toEqual([]);
  });
});

describe('analysis record carries `skipped` (#582)', () => {
  it('schema version is at least 1.2 (additive skipped list)', () => {
    // #761 moved this to 1.3 (additive `provenance`). The assertion pins the
    // floor this suite's field depends on rather than the exact current
    // version: `skipped` shipped at 1.2 and every later additive bump keeps it,
    // so re-pinning here on each bump would be churn that asserts nothing about
    // `skipped`. The exact-version pin lives once, in
    // guardian-coverage-notice-surface.test.ts, so a bump is still deliberate.
    const [major, minor] = SCHEMA_VERSION.split('.').map(Number);
    expect(major).toBe(1);
    expect(minor).toBeGreaterThanOrEqual(2);
  });

  it('records the suppression classes so adjudication can measure them', () => {
    // The reasons are deliberately distinct tokens ('test support' vs
    // 'type-only module'), and that distinction is only worth anything if it
    // survives into the record adjudication reads.
    const record = buildAnalysisRecord([], {
      ref: 'pr-7',
      gate: 'soft',
      effective_tier: 0,
      degraded_notice: null,
      exit_code: 0,
      checked: 3,
      skipped: [
        { name: 'src/types.ts', reason: 'type-only module' },
        { name: 'tests/conftest.py', reason: 'test support' },
      ],
    });

    expect(record.skipped).toEqual([
      { name: 'src/types.ts', reason: 'type-only module' },
      { name: 'tests/conftest.py', reason: 'test support' },
    ]);
  });

  it('defaults to an empty list, not undefined, on a no-skip run', () => {
    const record = buildAnalysisRecord([], {
      ref: 'pr-7',
      gate: 'soft',
      effective_tier: 0,
      degraded_notice: null,
      exit_code: 0,
      checked: 3,
    });
    expect(record.skipped).toEqual([]);
  });
});
