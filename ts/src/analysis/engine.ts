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
  buildFlakyTestsReport,
  buildRegressionCandidatesReport,
  buildFailureSpikesReport,
} from './reports.js';
import type {
  AreaHealthRow,
  CommonFailureRow,
  FlakyRow,
  RegressionRow,
  SpikeRow,
} from './rows.js';
import { detectRegressions } from '../history/detector.js';
import type { AsyncHistoryStore } from '../history/async-store.js';
import type { RunRecord } from '../history/record.js';
import { def } from '../util/coalesce.js';

/**
 * A store that additionally exposes raw records — today, only the local NDJSON
 * backend behind `LocalAsyncAdapter`. See `AsyncHistoryStore.readAll` for why
 * this is an optional capability rather than part of the contract proper.
 */
type ReadableStore = AsyncHistoryStore &
  Required<Pick<AsyncHistoryStore, 'readAll'>>;

function isReadable(store: AsyncHistoryStore): store is ReadableStore {
  return typeof store.readAll === 'function';
}

type RawRecord = RunRecord;
type RawTest = NonNullable<RawRecord['tests']>[number];

function isFailureWithError(t: RawTest): boolean {
  return (
    (t.status === 'failed' || t.status === 'flaky') && Boolean(t.error_text)
  );
}

function toCommonFailureRow(record: RawRecord, t: RawTest): CommonFailureRow {
  return {
    test_name: t.test_name,
    suite: def(record.suite, ''),
    failure_category: def(t.failure_category, 'other'),
    error_text: t.error_text as string,
  };
}

export interface AnalysisResult {
  flaky: FlakyRow[];
  spikes: SpikeRow[];
  areaHealth: AreaHealthRow[];
  commonFailures: CommonFailureRow[];
  regressionCandidates: RegressionRow[];
  digestMd: string;
  artifacts: Record<string, string>;
  /**
   * Sections this run could NOT compute, named in report language (#711).
   *
   * Empty on the local store. Non-empty only when the backend does not
   * implement the optional `readAll()` capability, in which case the sections
   * listed here are UNKNOWN rather than clean — their rows are `[]` for want of
   * data access, not for want of findings, and a caller that renders them as an
   * all-clear is reporting a measurement that never happened.
   */
  degraded: string[];
}

/** Report-language names for the sections that need raw-record access. */
const SECTION_SPIKES = 'failure spikes';
const SECTION_COMMON_FAILURES = 'common failures';
const SECTION_REGRESSIONS = 'regression candidates';

/**
 * Digest inputs, each named for the unit it carries (#670, #673).
 *
 * `windowRuns` counts RUNS (not days), `deltaPp` is a PERCENTAGE-POINT increase
 * (not a percentage), and `minFlakeRatePct` is a 0-100 percentage. The names
 * match the report builders they feed and the `--window-runs` / `--delta-pp` /
 * `--min-rate-pct` flags they are bound to, so the unit survives the whole trip
 * from the command line to the rendered threshold.
 */
export interface RunOptions {
  windowRuns?: number;
  deltaPp?: number;
  weeks?: number;
  minSuites?: number;
  minFlakeRatePct?: number;
  minGreen?: number;
  recentFailures?: number;
  suite?: string | null;
}

export class AnalysisEngine {
  constructor(private readonly store: AsyncHistoryStore) {}

  async run(opts: RunOptions = {}): Promise<AnalysisResult> {
    const windowRuns = opts.windowRuns ?? 30;
    const deltaPp = opts.deltaPp ?? 20.0;
    const weeks = opts.weeks ?? 4;
    const minSuites = opts.minSuites ?? 2;
    const minFlakeRatePct = opts.minFlakeRatePct ?? 10.0;
    const minGreen = opts.minGreen ?? 5;
    const recentFailures = opts.recentFailures ?? 3;
    const suite = opts.suite ?? null;

    const flaky = (await this.store.queryFlaky(
      windowRuns,
      suite,
      minFlakeRatePct,
    )) as FlakyRow[];

    // Sections that need raw-record access are UNKNOWN, not empty, on a backend
    // that does not offer it (#711). `flaky` above and a suite-scoped `spikes`
    // below ride real contract methods, so they stay measured either way.
    const degraded: string[] = [];
    const readable = isReadable(this.store);

    const suitesToQuery = suite ? [suite] : await this.discoverSuites();
    // With no explicit --suite, the suite list itself comes from raw records —
    // so spikes is only degraded in that case, not whenever readAll is absent.
    if (!readable && !suite) degraded.push(SECTION_SPIKES);
    const spikesRows: SpikeRow[] = [];
    for (const s of suitesToQuery) {
      const summary = await this.store.querySummary(s, windowRuns * 2);
      for (const row of def(summary.runs, [])) {
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

    const commonRows = await this.queryCommonFailures(suite);
    if (!readable) degraded.push(SECTION_COMMON_FAILURES);
    const regressionCandidates = await this.detectRegressionCandidates(
      suite,
      minGreen,
      recentFailures,
    );
    if (!readable) degraded.push(SECTION_REGRESSIONS);

    const digest = buildDigest({
      flaky,
      spikes: spikesRows,
      areaHealth: areaRows,
      commonFailures: commonRows,
      regressionCandidates,
      windowRuns,
      deltaPp,
      weeks,
      minSuites,
    });

    const artifacts: Record<string, string> = {
      'flaky.md': buildFlakyTestsReport(flaky, windowRuns, minFlakeRatePct),
      'spikes.md': buildFailureSpikesReport(spikesRows, deltaPp),
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
      degraded,
    };
  }

  async discoverSuites(): Promise<string[]> {
    if (!isReadable(this.store)) return [];
    const suites = new Set<string>();
    for (const r of await this.store.readAll()) {
      if (r.suite) suites.add(r.suite);
    }
    return [...suites];
  }

  async queryCommonFailures(suite: string | null): Promise<CommonFailureRow[]> {
    if (!isReadable(this.store)) return [];
    const rows: CommonFailureRow[] = [];
    for (const record of await this.store.readAll()) {
      if (suite && record.suite !== suite) continue;
      for (const t of def(record.tests, [])) {
        if (isFailureWithError(t)) rows.push(toCommonFailureRow(record, t));
      }
    }
    return rows;
  }

  async detectRegressionCandidates(
    suite: string | null,
    minGreen: number,
    recentFailures: number,
  ): Promise<RegressionRow[]> {
    if (!isReadable(this.store)) return [];
    const testNames = new Set<string>();
    for (const record of await this.store.readAll()) {
      if (suite && record.suite !== suite) continue;
      for (const t of def(record.tests, [])) testNames.add(t.test_name);
    }

    const candidates: RegressionRow[] = [];
    for (const name of testNames) {
      const timeline = await this.store.queryTimeline(name);
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
