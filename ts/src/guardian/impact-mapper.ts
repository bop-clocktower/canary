/**
 * Map an `ApiDiff` against test coverage rows to produce impact gaps.
 *
 * Faithful TypeScript port of `agent/guardian/impact_mapper.py`. Coverage rows
 * come from canary coverage (coverage-report.json) — each row identifies which
 * test exercises which endpoint.
 *
 * Severity rules:
 *   CRITICAL — removed endpoint with existing tests (tests will break)
 *   HIGH     — added endpoint with no coverage (gap), or changed with no coverage
 *   MEDIUM   — changed endpoint with existing tests (silent contract drift risk)
 *   LOW      — added endpoint that already has coverage (rare, shared fixtures)
 */

import { ApiDiff, ChangeType } from './diff-extractor.js';

/** Python: `Severity(str, Enum)`. */
export enum Severity {
  CRITICAL = 'critical',
  HIGH = 'high',
  MEDIUM = 'medium',
  LOW = 'low',
}

/**
 * Python: `Severity.sort_key` (ascending — CRITICAL sorts first). The canonical
 * severity ordering; reached from outside this module through
 * {@link severitySortKey} rather than directly (#544).
 */
const SEVERITY_SORT_KEY: Record<Severity, number> = {
  [Severity.CRITICAL]: 0,
  [Severity.HIGH]: 1,
  [Severity.MEDIUM]: 2,
  [Severity.LOW]: 3,
};

/** Python: `Severity.sort_key` accessor. */
export function severitySortKey(severity: Severity): number {
  return SEVERITY_SORT_KEY[severity];
}

/** A coverage row from coverage-report.json. */
export interface CoverageRow {
  path: string;
  method: string;
  test_name: string;
  [key: string]: unknown;
}

/** Python: `ImpactGap` dataclass. */
export class ImpactGap {
  path: string;
  method: string;
  // `string | null`: carries through an EndpointChange.operation_id that was a
  // present-null in the source spec (Python assigns change.operation_id as-is).
  operation_id: string | null;
  change_type: ChangeType;
  severity: Severity;
  affected_tests: string[];

  constructor(init: {
    path: string;
    method: string;
    operation_id: string | null;
    change_type: ChangeType;
    severity: Severity;
    affected_tests?: string[];
  }) {
    this.path = init.path;
    this.method = init.method;
    this.operation_id = init.operation_id;
    this.change_type = init.change_type;
    this.severity = init.severity;
    this.affected_tests = init.affected_tests ?? [];
  }
}

/**
 * Python: `_normalize_path`. Normalize path parameter syntax for matching:
 * converts both `:id` and `{id}` forms to `{id}` so coverage rows and OpenAPI
 * paths match regardless of which convention is used.
 */
function normalizePath(path: string): string {
  return path.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '{$1}');
}

function coverageKey(path: string, method: string): string {
  return JSON.stringify([normalizePath(path), method.toLowerCase()]);
}

/**
 * Python: `map_impact`. Map diff changes to test impact gaps, sorted by
 * severity (stable — CRITICAL first).
 */
export function mapImpact(
  diff: ApiDiff,
  coverageRows: CoverageRow[],
): ImpactGap[] {
  // Build a lookup: normalized_path+method -> list of test_names.
  const coverage = new Map<string, string[]>();
  for (const row of coverageRows) {
    const key = coverageKey(row.path, row.method);
    const existing = coverage.get(key);
    if (existing) {
      existing.push(row.test_name);
    } else {
      coverage.set(key, [row.test_name]);
    }
  }

  const gaps: ImpactGap[] = [];

  for (const change of diff.removed) {
    const tests = coverage.get(coverageKey(change.path, change.method)) ?? [];
    gaps.push(
      new ImpactGap({
        path: change.path,
        method: change.method,
        operation_id: change.operation_id,
        change_type: ChangeType.REMOVED,
        severity: tests.length ? Severity.CRITICAL : Severity.HIGH,
        affected_tests: tests,
      }),
    );
  }

  for (const change of diff.added) {
    const tests = coverage.get(coverageKey(change.path, change.method)) ?? [];
    gaps.push(
      new ImpactGap({
        path: change.path,
        method: change.method,
        operation_id: change.operation_id,
        change_type: ChangeType.ADDED,
        severity: tests.length ? Severity.LOW : Severity.HIGH,
        affected_tests: tests,
      }),
    );
  }

  for (const change of diff.changed) {
    const tests = coverage.get(coverageKey(change.path, change.method)) ?? [];
    gaps.push(
      new ImpactGap({
        path: change.path,
        method: change.method,
        operation_id: change.operation_id,
        change_type: ChangeType.CHANGED,
        severity: tests.length ? Severity.MEDIUM : Severity.HIGH,
        affected_tests: tests,
      }),
    );
  }

  // Python `sorted(...)` returns a new list and is stable.
  return [...gaps].sort(
    (a, b) => severitySortKey(a.severity) - severitySortKey(b.severity),
  );
}
