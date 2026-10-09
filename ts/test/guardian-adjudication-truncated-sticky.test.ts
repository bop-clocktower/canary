/**
 * A size-truncated sticky (#457) must not be read as a complete findings list.
 *
 * When the comment budget omits rows, the sticky says so in an overflow note.
 * Adjudication (ADR 0025) compared first vs last revision by the rows it could
 * see, so a finding that was still active at merge but cut from the LAST
 * revision for space looked "gone" -- and, coverage-verified with its file in
 * the merged diff, was counted as a TRUE POSITIVE, inflating precision.
 *
 * Found by bug-fleet (area A2, base b0e258bd).
 */

import { describe, expect, it } from 'vitest';

import { deriveReport } from '../src/guardian/adjudication.js';
import { Fidelity } from '../src/guardian/coverage.js';
import { Severity } from '../src/guardian/impact-mapper.js';
import { GuardianFinding, renderFindings } from '../src/guardian/pr-check.js';

function finding(path: string, severity: Severity, evidenceLen: number) {
  return new GuardianFinding({
    path,
    unit: path,
    fidelity: Fidelity.CoverageVerified,
    severity,
    evidence: 'x'.repeat(evidenceLen),
  });
}

describe('adjudication over a truncated sticky', () => {
  it('never counts a finding cut for space as a true positive', () => {
    const target = finding('src/a.ts', Severity.LOW, 10);
    const first = renderFindings([target], 'comment');
    // The last revision still carries the finding, but a flood of more severe
    // findings pushes it past the budget, so its row is omitted.
    const flood = Array.from({ length: 400 }, (_, i) =>
      finding(`src/f${i}.ts`, Severity.HIGH, 300),
    );
    const last = renderFindings([...flood, target], 'comment');

    const report = deriveReport(
      [
        {
          number: 1,
          revisions: [first, last],
          files: [{ filename: 'src/a.ts', patch: '' }],
        },
      ],
      1,
    );
    expect(report.counts['true-positive']).toBe(0);
  });
});
