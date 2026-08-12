/**
 * #457 — the sticky PR comment must stay under GitHub's hard size limit.
 *
 * `render(..., 'comment')` emitted every finding in full with no cap. GitHub
 * rejects an issue/PR comment body over **65,536 characters**, and the guardian's
 * post path treats that failure as "could not post" — so on a large PR the gate
 * would silently produce nothing, which is exactly the silent-green failure mode
 * #369 was filed for. A downstream audit already saw a 27,316-char comment (141
 * findings) — ~42% of the ceiling on one PR.
 *
 * The cap is applied ONLY to the rendered comment. The `--emit-analysis` JSON
 * record is the complete, authoritative set and must never be truncated.
 */

import { describe, expect, it } from 'vitest';

import { ChangedUnit, Fidelity } from '../src/guardian/coverage.js';
import { Severity } from '../src/guardian/impact-mapper.js';
import {
  COMMENT_CHAR_BUDGET,
  GuardianFinding,
  render,
} from '../src/guardian/pr-check.js';

function unit(path: string): ChangedUnit {
  return { path, added_ranges: [[1, 2]] };
}

/** A finding whose evidence is `evidenceLen` chars, for size-driving tests. */
function finding(
  path: string,
  severity: Severity = Severity.HIGH,
  evidenceLen = 40,
): GuardianFinding {
  return new GuardianFinding({
    path,
    unit: unit(path).path,
    fidelity: Fidelity.CoverageVerified,
    severity,
    evidence: 'x'.repeat(evidenceLen),
  });
}

/** Build `n` findings, all the same severity unless overridden. */
function many(
  n: number,
  severity = Severity.HIGH,
  evidenceLen = 40,
): GuardianFinding[] {
  return Array.from({ length: n }, (_, i) =>
    finding(`src/module-${i}/file-${i}.ts`, severity, evidenceLen),
  );
}

describe('comment size cap (#457)', () => {
  it('leaves a small comment untouched', () => {
    const body = render(many(3), 'comment');

    expect(body).not.toContain('more finding');
    expect(body.length).toBeLessThan(COMMENT_CHAR_BUDGET);
    // All three rows present.
    for (let i = 0; i < 3; i++) expect(body).toContain(`file-${i}.ts`);
  });

  it('keeps a huge comment under the budget', () => {
    // ~2000 findings with long evidence would run far past GitHub's ceiling.
    const body = render(many(2000, Severity.HIGH, 300), 'comment');

    expect(body.length).toBeLessThanOrEqual(COMMENT_CHAR_BUDGET);
  });

  it('reports how many findings were omitted', () => {
    const body = render(many(2000, Severity.HIGH, 300), 'comment');

    // The overflow line must state a real count, not a vague "some".
    const match = /(\d+) more finding/.exec(body);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThan(0);
  });

  it('points at the full record rather than just dropping findings', () => {
    const body = render(many(2000, Severity.HIGH, 300), 'comment');

    expect(body.toLowerCase()).toContain('analysis');
  });

  it('truncates the LEAST severe first', () => {
    // One critical finding buried behind a flood of low ones must survive.
    const flood = many(2000, Severity.LOW, 300);
    const critical = finding('src/critical/thing.ts', Severity.CRITICAL, 40);
    const body = render([...flood, critical], 'comment');

    expect(body).toContain('src/critical/thing.ts');
  });

  it('still renders header and footer when nothing fits', () => {
    // A single finding larger than the whole budget must not produce a
    // malformed or empty comment.
    const body = render(
      [finding('src/huge.ts', Severity.HIGH, 200_000)],
      'comment',
    );

    expect(body.length).toBeLessThanOrEqual(COMMENT_CHAR_BUDGET);
    expect(body).toContain('Canary PR Guardian');
    expect(body).toContain('Confidence');
  });

  it('NEVER truncates the json record', () => {
    const findings = many(2000, Severity.HIGH, 300);
    const payload = JSON.parse(render(findings, 'json'));

    expect(payload.findings.length).toBe(2000);
    expect(JSON.stringify(payload).length).toBeGreaterThan(COMMENT_CHAR_BUDGET);
  });

  it('keeps the sticky marker so the upsert still matches', () => {
    const body = render(many(2000, Severity.HIGH, 300), 'comment');

    // Truncation must not cost the marker -- losing it would make every run
    // post a NEW comment instead of updating the existing one.
    expect(body.startsWith('<!-- canary-pr-guardian -->')).toBe(true);
  });
});
