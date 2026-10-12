/**
 * bug-fleet A1: `review-test --framework` is documented as "Force framework:
 * pytest, playwright, vitest, k6", but the value is never checked. Any
 * non-empty value skips the unlintable-file abstention, and the linter only
 * distinguishes `pytest` from everything else -- so a value it does not know
 * lints the file with the JS ruleset and reports a false clean.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

describe('review-test --framework rejects a value it cannot honour', () => {
  it('does not report a clean result for an unknown framework', async () => {
    const dir = mkTmp();
    try {
      const file = join(dir, 'README.md');
      writeFileSync(file, '# not a test file\n', 'utf-8');
      const res = await invokeCanary(['review-test', file, '-f', 'bogus']);
      expect(res.stdout).not.toContain('No issues found');
    } finally {
      rmTmp(dir);
    }
  });
});
