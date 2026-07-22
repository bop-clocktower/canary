/**
 * Row shapes consumed by the report builders.
 *
 * These mirror the pre-fetched query rows that the Python `reports.py` builders
 * receive from the history store — one shape per report. Ported field-for-field
 * so the TS builders produce identical output (see the parity harness).
 */

export interface FlakyRow {
  test_name: string;
  suite?: string;
  area?: string | null;
  flake_rate_pct: number;
  flake_count: number;
  total_runs: number;
}

export interface SpikeRow {
  suite: string;
  timestamp: string;
  total: number;
  failed: number;
  flaky?: number;
}

export interface AreaHealthRow {
  area: string;
  suite?: string;
  week?: string;
  timestamp?: string;
  pass_rate?: number | null;
}

export interface CommonFailureRow {
  test_name: string;
  suite: string;
  error_text?: string | null;
  failure_category?: string;
}

export interface RegressionRow {
  test_name: string;
  suite?: string;
  area?: string | null;
  green_streak?: number | string;
  first_failure_commit?: string;
}
