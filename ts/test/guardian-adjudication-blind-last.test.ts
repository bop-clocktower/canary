/**
 * A coverage-blind last sticky revision is not coverage evidence (ADR 0025).
 *
 * A true positive needs the finding to disappear AND its lines to become
 * covered. When the last run had no usable coverage report, its sticky says
 * "coverage unavailable" and judges at the heuristic tier, so a coverage-
 * verified finding's absence from it proves nothing about coverage. It was
 * nevertheless counted as a TRUE POSITIVE, inflating precision.
 *
 * Found by bug-fleet (area A2, base b0e258bd).
 */

import { describe, expect, it } from 'vitest';

import { deriveReport } from '../src/guardian/adjudication.js';
import { Fidelity } from '../src/guardian/coverage.js';
import type { CoverageInputState } from '../src/guardian/diff-coverage/orchestrator.js';
import { Severity } from '../src/guardian/impact-mapper.js';
import { GuardianFinding, renderFindings } from '../src/guardian/pr-check.js';

describe('adjudication over a coverage-blind last revision', () => {
  it('does not count a finding that vanished from a blind run as a true positive', () => {
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
    // The last push lost its coverage artifact: no report parsed.
    const blind: CoverageInputState = {
      requested: 'coverage/lcov.info',
      found: false,
      parsed: false,
      filesInReport: 0,
      unitsMatched: 0,
      unitsTotal: 1,
    };
    const last = renderFindings([], 'comment', 0, null, {
      checked: 1,
      abstained: false,
      coverage: blind,
    });
    expect(last).toContain('coverage unavailable');

    const report = deriveReport(
      [
        {
          number: 1,
          revisions: [first, last],
          files: [{ filename: 'src/a.ts', patch: '@@ -1,0 +1,1 @@\n+x' }],
        },
      ],
      1,
    );
    expect(report.counts['true-positive']).toBe(0);
  });
});
