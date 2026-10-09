/**
 * The #457 comment budget must hold once the #761 provenance line is present.
 *
 * `renderFindings(..., 'comment')` fills finding rows against a reserve that
 * accounts for the tail it appends (overflow note, suppressed note, footer).
 * #761 later added a provenance line to that tail, but not to the reserve, so a
 * comment that hits the budget overshoots it by the provenance line's length.
 *
 * Found by bug-fleet (area A2, base b0e258bd).
 */

import { describe, expect, it } from 'vitest';

import { Fidelity } from '../src/guardian/coverage.js';
import { Severity } from '../src/guardian/impact-mapper.js';
import {
  COMMENT_CHAR_BUDGET,
  GuardianFinding,
  renderFindings,
} from '../src/guardian/pr-check.js';

function many(n: number): GuardianFinding[] {
  return Array.from(
    { length: n },
    (_, i) =>
      new GuardianFinding({
        path: `src/m${i}.ts`,
        unit: `src/m${i}.ts`,
        fidelity: Fidelity.CoverageVerified,
        severity: Severity.HIGH,
        evidence: 'e',
      }),
  );
}

describe('comment budget with provenance (#457 x #761)', () => {
  it('keeps an overflowing comment within the budget when provenance is shown', () => {
    // A ref name is shown verbatim, so a long branch name makes the
    // provenance line longer than any one row's worth of leftover slack.
    const body = renderFindings(many(3000), 'comment', 0, null, {
      checked: 3000,
      abstained: false,
      provenance: {
        base: 'origin/main',
        head: `feature/${'a'.repeat(400)}`,
        origin: 'ci-base',
        fileCount: 3000,
        mergeRef: true,
      },
    });
    expect(body.length).toBeLessThanOrEqual(COMMENT_CHAR_BUDGET);
  });
});
