/**
 * Ported from tests/unit/test_guardian_impact.py — diff -> test impact mapping.
 * Asserts the same cases as the Python oracle, plus extra severity branches.
 */

import { describe, expect, it } from 'vitest';

import {
  ApiDiff,
  ChangeType,
  EndpointChange,
} from '../src/guardian/diff-extractor.js';
import {
  CoverageRow,
  mapImpact,
  Severity,
  severitySortKey,
} from '../src/guardian/impact-mapper.js';

function change(
  path: string,
  method: string,
  changeType: ChangeType,
  operationId = 'op',
): EndpointChange {
  return new EndpointChange({
    path,
    method,
    change_type: changeType,
    operation_id: operationId,
  });
}

function coverageRow(
  path: string,
  method: string,
  testName: string,
  suite = 'api',
): CoverageRow {
  return {
    path,
    method,
    test_name: testName,
    suite,
    test_file: `tests/${suite}/test.spec.ts`,
  };
}

describe('mapImpact', () => {
  it('new endpoint with no coverage is HIGH severity', () => {
    const diff = new ApiDiff(
      [change('/v2/new', 'post', ChangeType.ADDED)],
      [],
      [],
    );
    const gaps = mapImpact(diff, []);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.severity).toBe(Severity.HIGH);
    expect(gaps[0]!.change_type).toBe(ChangeType.ADDED);
    expect(gaps[0]!.affected_tests).toEqual([]);
  });

  it('new endpoint that already has coverage is LOW severity', () => {
    const diff = new ApiDiff(
      [change('/v2/new', 'post', ChangeType.ADDED)],
      [],
      [],
    );
    const gaps = mapImpact(diff, [
      coverageRow('/v2/new', 'post', 'POST /v2/new - shared fixture'),
    ]);
    expect(gaps[0]!.severity).toBe(Severity.LOW);
    expect(gaps[0]!.affected_tests).toHaveLength(1);
  });

  it('removed endpoint with tests is CRITICAL', () => {
    const diff = new ApiDiff(
      [],
      [change('/v2/old', 'delete', ChangeType.REMOVED)],
      [],
    );
    const gaps = mapImpact(diff, [
      coverageRow('/v2/old', 'delete', 'DELETE /v2/old - should remove'),
    ]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.severity).toBe(Severity.CRITICAL);
    expect(gaps[0]!.affected_tests).toHaveLength(1);
  });

  it('removed endpoint without tests is HIGH', () => {
    const diff = new ApiDiff(
      [],
      [change('/v2/old', 'delete', ChangeType.REMOVED)],
      [],
    );
    const gaps = mapImpact(diff, []);
    expect(gaps[0]!.severity).toBe(Severity.HIGH);
  });

  it('changed endpoint with tests is MEDIUM severity', () => {
    const diff = new ApiDiff(
      [],
      [],
      [change('/v2/members', 'get', ChangeType.CHANGED)],
    );
    const gaps = mapImpact(diff, [
      coverageRow('/v2/members', 'get', 'GET /v2/members - should list'),
    ]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.severity).toBe(Severity.MEDIUM);
    expect(gaps[0]!.affected_tests).toHaveLength(1);
  });

  it('changed endpoint without tests is HIGH severity', () => {
    const diff = new ApiDiff(
      [],
      [],
      [change('/v2/members', 'get', ChangeType.CHANGED)],
    );
    const gaps = mapImpact(diff, []);
    expect(gaps[0]!.severity).toBe(Severity.HIGH);
  });

  it('no diff returns empty gaps', () => {
    const gaps = mapImpact(new ApiDiff([], [], []), []);
    expect(gaps).toEqual([]);
  });

  it('matches path parameters across :id and {id} conventions', () => {
    const diff = new ApiDiff(
      [],
      [],
      [change('/v2/members/{id}', 'get', ChangeType.CHANGED)],
    );
    const gaps = mapImpact(diff, [
      coverageRow('/v2/members/{id}', 'get', 'GET /v2/members/:id - member'),
      coverageRow('/v2/members/{id}', 'get', 'GET /v2/members/:id - 404'),
    ]);
    expect(gaps[0]!.affected_tests).toHaveLength(2);
  });

  it('normalizes :id in the coverage row path to {id}', () => {
    const diff = new ApiDiff(
      [],
      [],
      [change('/v2/members/{id}', 'get', ChangeType.CHANGED)],
    );
    // Coverage row uses the :id convention; must still match {id}.
    const gaps = mapImpact(diff, [
      coverageRow('/v2/members/:id', 'get', 'GET /v2/members/:id - member'),
    ]);
    expect(gaps[0]!.affected_tests).toHaveLength(1);
  });

  it('sorts gaps by severity (stable, CRITICAL first)', () => {
    const diff = new ApiDiff(
      [change('/v2/new', 'post', ChangeType.ADDED)],
      [change('/v2/old', 'delete', ChangeType.REMOVED)],
      [change('/v2/existing', 'get', ChangeType.CHANGED)],
    );
    const gaps = mapImpact(diff, [
      coverageRow('/v2/old', 'delete', 'test for old'),
    ]);
    const severities = gaps.map((g) => g.severity);
    expect(severities.indexOf(Severity.CRITICAL)).toBeLessThan(
      severities.indexOf(Severity.HIGH),
    );
  });

  it('orders all four severities correctly', () => {
    const diff = new ApiDiff(
      [
        change('/low', 'post', ChangeType.ADDED), // LOW (has coverage)
        change('/high', 'put', ChangeType.ADDED), // HIGH (no coverage)
      ],
      [change('/crit', 'delete', ChangeType.REMOVED)], // CRITICAL (has coverage)
      [change('/med', 'get', ChangeType.CHANGED)], // MEDIUM (has coverage)
    );
    const gaps = mapImpact(diff, [
      coverageRow('/low', 'post', 't1'),
      coverageRow('/crit', 'delete', 't2'),
      coverageRow('/med', 'get', 't3'),
    ]);
    expect(gaps.map((g) => g.severity)).toEqual([
      Severity.CRITICAL,
      Severity.HIGH,
      Severity.MEDIUM,
      Severity.LOW,
    ]);
  });
});

describe('severitySortKey', () => {
  it('ranks critical < high < medium < low', () => {
    expect(severitySortKey(Severity.CRITICAL)).toBe(0);
    expect(severitySortKey(Severity.HIGH)).toBe(1);
    expect(severitySortKey(Severity.MEDIUM)).toBe(2);
    expect(severitySortKey(Severity.LOW)).toBe(3);
  });
});
