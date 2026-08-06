/**
 * Severity must discriminate among coverage-verified findings (#553).
 *
 * Before this suite, `buildFindings` derived severity from fidelity alone, so
 * every coverage-verified finding was `HIGH` and nothing was ever `CRITICAL`.
 * Measured over 274 downstream runs: 1,488 coverage-verified findings, 100% of
 * them `high`. That makes `HARD_GATE_SEVERITIES = {CRITICAL, HIGH}` exactly
 * equivalent to "any coverage-verified finding" — a filter that does not
 * filter — and leaves a reviewer facing 68 equally-ranked rows with no way to
 * tell which one matters.
 *
 * The tests below pin the discrimination itself, not just the labels: the
 * distribution case fails if a future rule collapses every finding back onto
 * one severity, which is the exact shape of the original defect.
 */

import { describe, expect, it } from 'vitest';

import {
  type CoverageResult,
  Fidelity,
  type LineRange,
} from '../src/guardian/coverage.js';
import { Severity } from '../src/guardian/impact-mapper.js';
import {
  buildFindings,
  computeExitCode,
  render,
} from '../src/guardian/pr-check.js';

/**
 * A coverage-verified uncovered result with `uncovered` unhit lines out of
 * `added` lines the diff added. Line numbers are arbitrary but consistent: the
 * uncovered lines are the first `uncovered` of the added range.
 */
function verified(
  uncovered: number,
  added: number,
  path = 'pkg/foo.ts',
): CoverageResult {
  const added_ranges: LineRange[] = added > 0 ? [[1, added]] : [];
  const uncovered_lines = Array.from({ length: uncovered }, (_, i) => i + 1);
  return {
    unit: { path, added_ranges },
    covered: false,
    fidelity: Fidelity.CoverageVerified,
    evidence: 'lcov',
    uncovered_lines,
  };
}

function severityOf(result: CoverageResult): Severity {
  const findings = buildFindings([result]);
  expect(findings).toHaveLength(1);
  return findings[0]!.severity;
}

describe('coverage-verified severity: volume x share of the added change', () => {
  it('a large, wholly-untested new block is CRITICAL', () => {
    expect(severityOf(verified(20, 20))).toBe(Severity.CRITICAL);
    expect(severityOf(verified(132, 140))).toBe(Severity.CRITICAL);
  });

  it('large volume at a low share is HIGH, not CRITICAL', () => {
    // 25 uncovered lines is a lot, but they are a quarter of the change --
    // the unit is substantially tested, so it should not outrank a block
    // that nothing executes at all.
    expect(severityOf(verified(25, 100))).toBe(Severity.HIGH);
  });

  it('a high share at a small volume is HIGH', () => {
    // 4 of 5 added lines unhit: too small to be CRITICAL, too concentrated
    // to wave through.
    expect(severityOf(verified(4, 5))).toBe(Severity.HIGH);
  });

  it('moderate volume at any share is HIGH', () => {
    expect(severityOf(verified(6, 100))).toBe(Severity.HIGH);
  });

  it('a few uncovered lines in a mostly-tested change is MEDIUM', () => {
    // The guard-clause case: 2 unhit lines out of 30 added. Real, worth
    // reporting, not worth blocking a PR over.
    expect(severityOf(verified(2, 30))).toBe(Severity.MEDIUM);
    expect(severityOf(verified(4, 30))).toBe(Severity.MEDIUM);
  });

  it('escalates rather than downgrades when line detail is missing', () => {
    // An uncovered coverage-verified result with no line numbers means the
    // tier could not say WHICH lines were unhit -- not that few were. An
    // absent measurement must never read as a low score (ADR 0010).
    const noDetail = verified(0, 30);
    expect(noDetail.uncovered_lines).toEqual([]);
    expect(severityOf(noDetail)).toBe(Severity.HIGH);
  });

  it('escalates when the added-line count is unknown', () => {
    // No added_ranges -> the share denominator is unknown. Treat the change
    // as wholly uncovered rather than assuming it is well covered.
    expect(severityOf(verified(20, 0))).toBe(Severity.CRITICAL);
  });

  it('leaves the graph and heuristic tiers unchanged', () => {
    const graph: CoverageResult = {
      ...verified(0, 10),
      fidelity: Fidelity.GraphVerified,
    };
    const heuristic: CoverageResult = {
      ...verified(0, 10),
      fidelity: Fidelity.Heuristic,
    };
    expect(severityOf(graph)).toBe(Severity.HIGH);
    expect(severityOf(heuristic)).toBe(Severity.MEDIUM);
  });
});

describe('the severity filter actually filters', () => {
  it('a realistic batch spans more than one severity', () => {
    // The regression guard for #553 itself. A rule that collapses every
    // coverage-verified finding onto a single severity -- whatever that
    // severity is -- fails here.
    const batch = [
      verified(40, 40, 'pkg/a.ts'),
      verified(30, 120, 'pkg/b.ts'),
      verified(6, 60, 'pkg/c.ts'),
      verified(2, 40, 'pkg/d.ts'),
      verified(1, 80, 'pkg/e.ts'),
    ];
    const severities = new Set(buildFindings(batch).map((f) => f.severity));
    expect(severities.size).toBeGreaterThan(1);
    expect(severities).toContain(Severity.CRITICAL);
    expect(severities).toContain(Severity.HIGH);
    expect(severities).toContain(Severity.MEDIUM);
  });

  it('the hard gate blocks on the serious findings and passes the rest', () => {
    const trivial = buildFindings([verified(2, 40)]);
    const serious = buildFindings([verified(40, 40)]);
    expect(computeExitCode(trivial, 'hard')).toBe(0);
    expect(computeExitCode(serious, 'hard')).toBe(1);
  });

  it('sums added lines across every range of a scattered change', () => {
    // A diff that touches three separate places in a file. The share
    // denominator is the whole change (10 + 5 + 5 = 20 lines), not one hunk:
    // grading against a single range would score 8/10 = 0.8 and escalate.
    const scattered: CoverageResult = {
      unit: {
        path: 'pkg/scattered.ts',
        added_ranges: [
          [1, 10],
          [40, 44],
          [80, 84],
        ],
      },
      covered: false,
      fidelity: Fidelity.CoverageVerified,
      evidence: 'lcov',
      uncovered_lines: [1, 2, 3, 4, 5, 6, 7, 8],
    };
    // 8 of 20 -> share 0.4, volume 8 -> HIGH by volume, not CRITICAL.
    expect(severityOf(scattered)).toBe(Severity.HIGH);
  });

  it('renders a critical finding on the sticky comment', () => {
    // CRITICAL was unreachable before this change, so the comment path had
    // never actually rendered one -- a missing icon-map entry would have gone
    // unnoticed until the first real critical finding in a consumer repo.
    const findings = buildFindings([verified(40, 40, 'pkg/worst.ts')]);
    expect(findings[0]!.severity).toBe(Severity.CRITICAL);
    const body = render(findings, 'markdown');
    expect(body).toContain('critical');
    expect(body).toContain('pkg/worst.ts');
  });

  it('gives critical and high distinct icons', () => {
    // The icon column is the only part of a row read at a glance. While
    // CRITICAL was unreachable the two shared a red circle harmlessly; a
    // shared glyph now would hide the ranking this change exists to create.
    const critical = render(buildFindings([verified(40, 40)]), 'comment');
    const high = render(buildFindings([verified(6, 60)]), 'comment');
    const iconOf = (body: string) =>
      /\| (\S+) (critical|high|medium|low) \|/.exec(body)?.[1];
    expect(iconOf(critical)).toBeDefined();
    expect(iconOf(high)).toBeDefined();
    expect(iconOf(critical)).not.toBe(iconOf(high));
  });

  it('findings sort with the most severe first', () => {
    const findings = buildFindings([
      verified(2, 40, 'pkg/low.ts'),
      verified(40, 40, 'pkg/worst.ts'),
      verified(6, 60, 'pkg/mid.ts'),
    ]);
    expect(findings.map((f) => f.path)).toEqual([
      'pkg/worst.ts',
      'pkg/mid.ts',
      'pkg/low.ts',
    ]);
  });
});
