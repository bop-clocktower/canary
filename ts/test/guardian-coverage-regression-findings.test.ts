/**
 * #606 — turning a base-vs-head coverage drop into guardian findings.
 *
 * The delta module measures; this is the layer that grades. A regression is
 * graded by how far it fell and never reaches CRITICAL: unlike an uncovered
 * new block, a drop is a relative measurement across two artifacts guardian
 * cannot itself verify are comparable.
 */

import { describe, expect, it } from 'vitest';

import { Severity } from '../src/guardian/impact-mapper.js';
import { buildRegressionFindings } from '../src/guardian/pr-check.js';
import type { UnitCoverageDelta } from '../src/guardian/coverage.js';

const delta = (
  path: string,
  base: [number, number],
  head: [number, number],
): UnitCoverageDelta => {
  const b = { covered: base[0], coverable: base[1] };
  const h = { covered: head[0], coverable: head[1] };
  const dropPoints = (b.covered / b.coverable - h.covered / h.coverable) * 100;
  return { path, base: b, head: h, dropPoints, regressed: dropPoints > 0.1 };
};

describe('buildRegressionFindings', () => {
  it('emits nothing for deltas that did not regress', () => {
    const improved = delta('src/a.ts', [1, 4], [4, 4]);
    expect(buildRegressionFindings([improved])).toEqual([]);
  });

  it('grades a large drop HIGH and names both ratios in the evidence', () => {
    const [finding] = buildRegressionFindings([
      delta('src/a.ts', [4, 4], [1, 4]),
    ]);

    expect(finding).toBeDefined();
    expect(finding!.kind).toBe('coverage-regression');
    expect(finding!.path).toBe('src/a.ts');
    expect(finding!.severity).toBe(Severity.HIGH);
    expect(finding!.evidence).toContain('100.0%');
    expect(finding!.evidence).toContain('25.0%');
    expect(finding!.evidence).toContain('4/4');
    expect(finding!.evidence).toContain('1/4');
    expect(finding!.suggestion).not.toBe('');
  });

  it('grades a moderate drop MEDIUM and a slight drop LOW', () => {
    // 100% -> 90%: 10 points.
    const moderate = buildRegressionFindings([
      delta('src/m.ts', [10, 10], [9, 10]),
    ]);
    // 100% -> 99%: 1 point.
    const slight = buildRegressionFindings([
      delta('src/s.ts', [100, 100], [99, 100]),
    ]);

    expect(moderate[0]!.severity).toBe(Severity.MEDIUM);
    expect(slight[0]!.severity).toBe(Severity.LOW);
  });

  it('never grades a regression CRITICAL, however far it fell', () => {
    const total = buildRegressionFindings([
      delta('src/x.ts', [50, 50], [0, 50]),
    ]);
    expect(total[0]!.severity).toBe(Severity.HIGH);
  });

  it('marks the finding coverage-verified — both sides are measured', () => {
    const [finding] = buildRegressionFindings([
      delta('src/a.ts', [4, 4], [1, 4]),
    ]);
    expect(finding!.fidelity).toBe('coverage-verified');
  });

  it('orders several regressions worst-first, whatever order they arrive in', () => {
    // Every other case here passes a single delta, so the sort never runs on
    // more than one element. A reviewer reads the table top-down and treats
    // the first row as the worst, so the ordering is load-bearing, not
    // cosmetic — fed in deliberately worst-last.
    const findings = buildRegressionFindings([
      delta('src/low.ts', [100, 100], [97, 100]), // 3 points  -> LOW
      delta('src/high.ts', [100, 100], [50, 100]), // 50 points -> HIGH
      delta('src/medium.ts', [100, 100], [90, 100]), // 10 points -> MEDIUM
    ]);

    expect(findings.map((f) => f.severity)).toEqual([
      Severity.HIGH,
      Severity.MEDIUM,
      Severity.LOW,
    ]);
    expect(findings.map((f) => f.path)).toEqual([
      'src/high.ts',
      'src/medium.ts',
      'src/low.ts',
    ]);
  });
});
