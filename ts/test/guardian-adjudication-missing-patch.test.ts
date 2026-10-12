/**
 * A merged file whose `patch` GitHub omitted cannot prove "no suppression".
 *
 * REST `/pulls/{n}/files` drops `patch` for diffs it deems too large. Reading
 * the missing patch as empty made an `fp:` suppression in that file invisible,
 * so a finding the reviewer marked wrong (and that left the sticky because it
 * was suppressed) was counted as a TRUE POSITIVE (ADR 0025).
 *
 * Found by bug-fleet (area A2, base b0e258bd).
 */

import { describe, expect, it } from 'vitest';

import { deriveReport } from '../src/guardian/adjudication.js';
import { Fidelity } from '../src/guardian/coverage.js';
import { Severity } from '../src/guardian/impact-mapper.js';
import { GuardianFinding, renderFindings } from '../src/guardian/pr-check.js';

describe('adjudication when the merged patch is unavailable', () => {
  it('does not count a finding on a patchless file as a true positive', () => {
    const first = renderFindings(
      [
        new GuardianFinding({
          path: 'src/a.ts',
          unit: 'src/a.ts',
          fidelity: Fidelity.CoverageVerified,
          severity: Severity.HIGH,
          evidence: 'lines 3-4 unhit',
        }),
      ],
      'comment',
    );
    const last = renderFindings([], 'comment');
    const report = deriveReport(
      [
        {
          number: 1,
          revisions: [first, last],
          files: [{ filename: 'src/a.ts' }],
        },
      ],
      1,
    );
    expect(report.counts['true-positive']).toBe(0);
  });
});
