/**
 * Tests for the shared gate-abstention helper (#508, no-silent-abstention
 * D3/D4/D7): a check that verified zero items has abstained, not passed.
 */
import { describe, expect, it } from 'vitest';

import {
  EXIT_ABSTAINED,
  gateOutcome,
  GateResult,
} from '../src/core/gate-result.js';

const WARN = '\u{26A0}';

function result<F>(
  checked: number,
  findings: F[] = [],
  skipped?: { name: string; reason: string }[],
): GateResult<F> {
  return { checked, findings, skipped };
}

describe('gate-result helper', () => {
  it('reserves exit 3 for abstained (D4)', () => {
    expect(EXIT_ABSTAINED).toBe(3);
  });

  it('gate + zero denominator abstains loudly with exit 3', () => {
    const o = gateOutcome(result(0), 'gate');
    expect(o.exitCode).toBe(EXIT_ABSTAINED);
    expect(o.abstained).toBe(true);
    expect(o.summaryLine.toLowerCase()).toContain('abstained');
    expect(o.summaryLine).toContain(WARN);
  });

  it('advisory + zero denominator warns unmissably but exits 0 (D3)', () => {
    const o = gateOutcome(result(0), 'advisory');
    expect(o.exitCode).toBe(0);
    expect(o.abstained).toBe(true);
    expect(o.summaryLine.toLowerCase()).toContain('abstained');
    expect(o.summaryLine).toContain(WARN);
  });

  it('invalid denominators (negative, NaN) abstain, never pass', () => {
    for (const bad of [-1, Number.NaN]) {
      const o = gateOutcome(result(bad), 'gate');
      expect(o.exitCode).toBe(EXIT_ABSTAINED);
      expect(o.abstained).toBe(true);
      expect(o.summaryLine.toLowerCase()).toContain('abstained');
    }
  });

  it('findings outrank abstention: a finding proves something was checked', () => {
    const o = gateOutcome(result(0, ['x']), 'gate');
    expect(o.exitCode).toBe(1);
    expect(o.abstained).toBe(false);
    expect(o.summaryLine).toContain('1 finding(s) across 0 checked');
  });

  it('advisory clean pass uses the same run-count summary', () => {
    const o = gateOutcome(result(2), 'advisory');
    expect(o.exitCode).toBe(0);
    expect(o.abstained).toBe(false);
    expect(o.summaryLine).toContain('All 2 run check(s) passed');
  });

  it('gate with findings exits 1, not abstained', () => {
    const o = gateOutcome(result(3, ['finding']), 'gate');
    expect(o.exitCode).toBe(1);
    expect(o.abstained).toBe(false);
    expect(o.summaryLine).toContain('1 finding(s) across 3 checked');
  });

  it('advisory with findings still exits 0', () => {
    expect(gateOutcome(result(2, ['x']), 'advisory').exitCode).toBe(0);
  });

  it('clean pass says how many were run (D7 phrasing)', () => {
    const o = gateOutcome(result(4), 'gate');
    expect(o.exitCode).toBe(0);
    expect(o.abstained).toBe(false);
    expect(o.summaryLine).toContain('All 4 run check(s) passed');
  });

  it('clean-pass noun is parameterizable via opts.noun', () => {
    const o = gateOutcome(result(4), 'advisory', { noun: 'item(s)' });
    expect(o.summaryLine).toContain('All 4 run item(s) passed');
  });

  it('skip names cannot forge output lines (control chars stripped)', () => {
    const skipped = [
      { name: 'evil\u{1B}[32mOK\nAll checks passed', reason: 'spoof' },
    ];
    const o = gateOutcome(result(1, [], skipped), 'gate');
    expect(o.summaryLine).not.toContain('\n');
    expect(o.summaryLine).not.toContain('\u{1B}');
    expect(o.summaryLine).toContain(
      '(1 skipped: evil[32mOKAll checks passed [spoof])',
    );
  });

  it('a skip REASON cannot forge output lines either (#579)', () => {
    // Rendering `reason` (#579) made it a second injection surface; it is
    // sanitized on the same terms as `name`.
    const skipped = [
      { name: 'probe', reason: 'ok\u{1B}[32m\nAll checks passed' },
    ];
    const o = gateOutcome(result(1, [], skipped), 'gate');
    expect(o.summaryLine).not.toContain('\n');
    expect(o.summaryLine).not.toContain('\u{1B}');
    expect(o.summaryLine).toContain(
      '(1 skipped: probe [ok[32mAll checks passed])',
    );
  });

  it('skipped entries always render and never count as passed (D7)', () => {
    const skipped = [
      { name: 'mcp-probe', reason: 'no consent' },
      { name: 'net-check', reason: 'offline' },
    ];
    const clean = gateOutcome(result(4, [], skipped), 'gate');
    expect(clean.summaryLine).toContain('All 4 run check(s) passed');
    // #579: the CAUSE travels with the name. A reader who sees only names
    // cannot tell a configured skip from a built-in, non-configurable one.
    expect(clean.summaryLine).toContain(
      '(2 skipped: mcp-probe [no consent]; net-check [offline])',
    );
    // Skipped-everything is an abstention, not a pass.
    const allSkipped = gateOutcome(result(0, [], skipped), 'gate');
    expect(allSkipped.abstained).toBe(true);
    expect(allSkipped.exitCode).toBe(EXIT_ABSTAINED);
    expect(allSkipped.summaryLine).toContain('(2 skipped:');
    // Findings line carries the suffix too.
    const found = gateOutcome(result(3, ['f'], skipped), 'gate');
    expect(found.summaryLine).toContain('(2 skipped:');
  });

  it('entries sharing a reason are grouped, not repeated (#579)', () => {
    // Doctor's skip reasons are full remedy sentences, not short tokens like
    // the guardian's. Repeating one per name turned a 25-char summary into a
    // 183-char line saying the same thing twice. Names group under the reason
    // they share, in first-appearance order.
    const skipped = [
      { name: 'repo-access', reason: 'needs consent' },
      { name: 'cli-tooling', reason: 'needs consent' },
    ];
    const o = gateOutcome(result(3, [], skipped), 'gate');
    expect(o.summaryLine).toContain(
      '(2 skipped: repo-access, cli-tooling [needs consent])',
    );
  });
});
