/**
 * Ported from tests/unit/test_guardian_summary.py — impact summary Markdown.
 * Asserts the same cases as the Python oracle, plus extra formatting branches.
 */

import { describe, expect, it } from 'vitest';

import { ChangeType } from '../src/guardian/diff-extractor.js';
import { ImpactGap, Severity } from '../src/guardian/impact-mapper.js';
import { buildSummary } from '../src/guardian/summary-emitter.js';

function gap(
  path: string,
  method: string,
  changeType: ChangeType,
  severity: Severity,
  tests: string[] = [],
): ImpactGap {
  return new ImpactGap({
    path,
    method,
    operation_id: 'op',
    change_type: changeType,
    severity,
    affected_tests: tests,
  });
}

describe('buildSummary', () => {
  it('no gaps returns a clean message', () => {
    const md = buildSummary([], 'abc1234', 'api');
    const lower = md.toLowerCase();
    expect(
      lower.includes('no impact') ||
        lower.includes('no gaps') ||
        lower.includes('clean') ||
        lower.includes('unchanged'),
    ).toBe(true);
  });

  it('includes the commit sha', () => {
    const md = buildSummary([], 'abc1234', 'api');
    expect(md).toContain('abc1234');
  });

  it('includes a new-endpoint section', () => {
    const md = buildSummary(
      [gap('/v2/new', 'post', ChangeType.ADDED, Severity.HIGH)],
      'abc1234',
      'api',
    );
    expect(md).toContain('/v2/new');
    expect(md.includes('New endpoint') || md.includes('Added')).toBe(true);
  });

  it('shows existing test count for an added endpoint that has coverage', () => {
    const md = buildSummary(
      [gap('/v2/new', 'post', ChangeType.ADDED, Severity.LOW, ['t1', 't2'])],
      'abc1234',
      'api',
    );
    expect(md).toContain('2 existing test(s)');
  });

  it('includes a removed-endpoint section', () => {
    const md = buildSummary(
      [
        gap('/v2/old', 'delete', ChangeType.REMOVED, Severity.CRITICAL, [
          'DELETE /v2/old - should remove',
        ]),
      ],
      'abc1234',
      'api',
    );
    expect(md).toContain('/v2/old');
    expect(md.includes('Removed') || md.includes('removed')).toBe(true);
  });

  it('truncates the affected-test list at 5 with an overflow note', () => {
    const tests = Array.from({ length: 7 }, (_, i) => `test ${i}`);
    const md = buildSummary(
      [gap('/v2/old', 'delete', ChangeType.REMOVED, Severity.CRITICAL, tests)],
      'abc1234',
      'api',
    );
    expect(md).toContain('… and 2 more');
  });

  it('includes a changed-endpoint section', () => {
    const md = buildSummary(
      [
        gap('/v2/members', 'get', ChangeType.CHANGED, Severity.MEDIUM, [
          'GET /v2/members - should list',
        ]),
      ],
      'abc1234',
      'api',
    );
    expect(md).toContain('/v2/members');
    expect(md.includes('Changed') || md.includes('changed')).toBe(true);
  });

  it('includes a recommended-actions section', () => {
    const md = buildSummary(
      [gap('/v2/new', 'post', ChangeType.ADDED, Severity.HIGH)],
      'abc1234',
      'api',
    );
    expect(md.toLowerCase()).toContain('recommended');
  });

  it('produces distinct recommended actions per change type', () => {
    const md = buildSummary(
      [
        gap('/a', 'post', ChangeType.ADDED, Severity.HIGH),
        gap('/b', 'delete', ChangeType.REMOVED, Severity.CRITICAL),
        gap('/c', 'get', ChangeType.CHANGED, Severity.MEDIUM),
      ],
      'abc1234',
      'api',
    );
    expect(md).toContain('Write test for `POST /a` (no coverage)');
    expect(md).toContain('Remove/update tests for `DELETE /b` (will break)');
    expect(md).toContain(
      'Review tests for `GET /c` (silent contract drift risk)',
    );
  });

  it('renders the health snapshot when provided', () => {
    const md = buildSummary(
      [gap('/v2/new', 'post', ChangeType.ADDED, Severity.HIGH)],
      'abc1234',
      'api',
      'area health: 3 flaky tests',
    );
    expect(md).toContain('Current health (affected areas)');
    expect(md).toContain('area health: 3 flaky tests');
  });

  it('shows affected tests for a critical removed gap', () => {
    const md = buildSummary(
      [
        gap('/v2/old', 'delete', ChangeType.REMOVED, Severity.CRITICAL, [
          'DELETE /v2/old - test 1',
          'DELETE /v2/old - test 2',
        ]),
      ],
      'abc1234',
      'api',
    );
    expect(md.includes('test 1') || md.includes('test 2')).toBe(true);
  });

  it('returns a non-empty string', () => {
    const md = buildSummary([], 'abc1234', 'api');
    expect(typeof md).toBe('string');
    expect(md.length).toBeGreaterThan(0);
  });
});
