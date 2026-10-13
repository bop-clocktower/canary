/**
 * `pr-check --gate <value>` must be validated the way the config gate is.
 *
 * The config path (`coerceGate`) rejects anything outside {soft, hard} with a
 * loud WARNING, because an unknown gate must never silently disable
 * enforcement. The `--gate` override skipped that check entirely: a typo such
 * as `--gate hrad` reached `computeExitCode`, which treats every non-`hard`
 * value as soft, so a hard-gate CI job exited 0 with no word on any stream.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { invokeGuardian, mkTmp, rmTmp } from './guardian-cli-testkit.js';

const DIFF_NEW_UNIT = `diff --git a/pkg/widget.py b/pkg/widget.py
index 1111111..2222222 100644
--- a/pkg/widget.py
+++ b/pkg/widget.py
@@ -0,0 +1,3 @@
+def widget():
+    return 42
+
`;

let tmp: string;
beforeEach(() => {
  tmp = mkTmp();
});
afterEach(() => {
  rmTmp(tmp);
});

describe('pr-check --gate override validation', () => {
  it('an unknown --gate value warns loudly instead of silently running soft', async () => {
    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--format', 'json', '--gate', 'hrad'],
      { input: DIFF_NEW_UNIT, cwd: tmp },
    );
    expect(res.stderr).toMatch(/--gate must be 'soft' or 'hard', got "hrad"/);
  });

  it('a valid --gate value in any case is accepted without a warning', async () => {
    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--format', 'json', '--gate', ' HARD '],
      { input: DIFF_NEW_UNIT, cwd: tmp },
    );
    expect(res.stderr).not.toContain('--gate must be');
  });
});
