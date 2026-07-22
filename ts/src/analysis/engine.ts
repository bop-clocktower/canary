/**
 * AnalysisEngine — queries the history store and runs all report types.
 *
 * Faithful TS port of `agent/analysis/engine.py`. Thin coordinator: calls the
 * store's query methods, passes results to the pure builders in reports.ts, and
 * returns structured data plus Markdown artifacts.
 *
 * Fidelity note: as in Python, `areaHealth` is intentionally never populated by
 * `run()` (the Python engine initialises `area_rows = []` and never appends), so
 * the area-health artifact always renders the empty-data message.
 */

import {
  buildAreaHealthReport,
  buildCommonFailuresReport,
  buildDigest,
  buildFlakyReport,
  buildRegressionCandidatesReport,
  buildSpikesReport,
} from './reports.js';
import type {
  AreaHealthRow,
  CommonFailureRow,
  FlakyRow,
  RegressionRow,
  SpikeRow,
} from './rows.js';
import { detectRegressions } from '../history/detector.js';
import type { HistoryStore } from '../history/ndjson-store.js';

/** A store that additionally exposes the raw records (the local NDJSON store). */
interface ReadableStore extends HistoryStore {
  readAll(): Array<{
    run_id: string;
    suite?: string;
    tests?: Array<{
      test_name: string;
      status?: string;
      failure_category?: string | null;
      error_text?: string | null;
    }>;
  }>;
}

function isReadable(store: HistoryStore): store is ReadableStore {
  return typeof (store as ReadableStore).readAll === 'function';
}

export interface AnalysisResult {
  flaky: FlakyRow[];
  spikes: SpikeRow[];
  areaHealth: AreaHealthRow[];
  commonFailures: CommonFailureRow[];
  regressionCandidates: RegressionRow[];
  digestMd: string;
  artifacts: Record<string, string>;
}

export interface RunOptions {
  window?: number;
  delta?: number;
  weeks?: number;
  minSuites?: number;
  minFlakeRate?: number;
  minGreen?: number;
  recentFailures?: number;
  suite?: string | null;
}

export class AnalysisEngine {
  constructor(private readonly store: HistoryStore) {}

  run(opts: RunOptions = {}): AnalysisResult {
    const window = opts.window ?? 30;
    const delta = opts.delta ?? 20.0;
    const weeks = opts.weeks ?? 4;
    const minSuites = opts.minSuites ?? 2;
    const minFlakeRate = opts.minFlakeRate ?? 10.0;
    const minGreen = opts.minGreen ?? 5;
    const recentFailures = opts.recentFailures ?? 3;
    const suite = opts.suite ?? null;

    const flaky = this.store.queryFlaky(
      window,
      suite,
      minFlakeRate,
    ) as FlakyRow[];

    const suitesToQuery = suite ? [suite] : this.discoverSuites();
    const spikesRows: SpikeRow[] = [];
    for (const s of suitesToQuery) {
      const summary = this.store.querySummary(s, window * 2);
      for (const row of summary.runs ?? []) {
        // query_summary rows omit suite; the spikes builder groups by it, so
        // tag each pooled row with the suite it came from (matches Python).
        spikesRows.push({
          suite: s,
          timestamp: row.timestamp,
          total: row.total,
          failed: row.failed,
          flaky: row.flaky,
        });
      }
    }

    // Faithful to Python: area rows are never populated by run().
    const areaRows: AreaHealthRow[] = [];

    const commonRows = this.queryCommonFailures(suite);
    const regressionCandidates = this.detectRegressionCandidates(
      suite,
      minGreen,
      recentFailures,
    );

    const digest = buildDigest({
      flaky,
      spikes: spikesRows,
      areaHealth: areaRows,
      commonFailures: commonRows,
      regressionCandidates,
      window,
      delta,
      weeks,
      minSuites,
    });

    const artifacts: Record<string, string> = {
      'flaky.md': buildFlakyReport(flaky, window, minFlakeRate),
      'spikes.md': buildSpikesReport(spikesRows, delta),
      'area-health.md': buildAreaHealthReport(areaRows, weeks),
      'common-failures.md': buildCommonFailuresReport(commonRows, minSuites),
      'regression-candidates.md':
        buildRegressionCandidatesReport(regressionCandidates),
      'digest.md': digest,
    };

    return {
      flaky,
      spikes: spikesRows,
      areaHealth: areaRows,
      commonFailures: commonRows,
      regressionCandidates,
      digestMd: digest,
      artifacts,
    };
  }

  discoverSuites(): string[] {
    if (!isReadable(this.store)) return [];
    const suites = new Set<string>();
    for (const r of this.store.readAll()) {
      if (r.suite) suites.add(r.suite);
    }
    return [...suites];
  }

  queryCommonFailures(suite: string | null): CommonFailureRow[] {
    if (!isReadable(this.store)) return [];
    const rows: CommonFailureRow[] = [];
    for (const record of this.store.readAll()) {
      if (suite && record.suite !== suite) continue;
      for (const t of record.tests ?? []) {
        if ((t.status === 'failed' || t.status === 'flaky') && t.error_text) {
          rows.push({
            test_name: t.test_name,
            suite: record.suite ?? '',
            failure_category: t.failure_category ?? 'other',
            error_text: t.error_text,
          });
        }
      }
    }
    return rows;
  }

  detectRegressionCandidates(
    suite: string | null,
    minGreen: number,
    recentFailures: number,
  ): RegressionRow[] {
    if (!isReadable(this.store)) return [];
    const testNames = new Set<string>();
    for (const record of this.store.readAll()) {
      if (suite && record.suite !== suite) continue;
      for (const t of record.tests ?? []) testNames.add(t.test_name);
    }

    const candidates: RegressionRow[] = [];
    for (const name of testNames) {
      const timeline = this.store.queryTimeline(name);
      const result = detectRegressions(timeline, minGreen, recentFailures);
      if (result.is_regression) {
        candidates.push({
          test_name: name,
          suite: timeline.length > 0 ? timeline[0]!.suite : '',
          area: null,
          green_streak: result.green_streak,
          ...(result.first_failure_commit
            ? { first_failure_commit: result.first_failure_commit }
            : {}),
        });
      }
    }
    return candidates;
  }
}
