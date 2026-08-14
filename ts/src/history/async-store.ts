/**
 * The async history-store contract.
 *
 * Extracted from `store.ts` to break a circular dependency (#543): the store
 * factory has to import every concrete backend it can return, while each
 * backend has to import the interface it implements. Both now point at this
 * leaf and neither points at the other. `store.ts` re-exports the type, so
 * existing importers are unaffected.
 *
 * The dependency was type-only, and type-only imports are erased before
 * anything runs — so this was never a runtime hazard. It is fixed anyway
 * because `harness check-deps` counts it, and a cycle the gate reports is a
 * cycle whatever the emitted JavaScript does.
 *
 * The contract itself is async (unlike the synchronous Python `HistoryStore`
 * ABC) because `@supabase/supabase-js` is Promise-based; see `store.ts` for the
 * full boundary note.
 */

import type { FlakyQueryRow, SummaryResult } from './ndjson-store.js';
import type { RunRecord, TimelineEntry } from './record.js';
import type { RunInput, TestResultInput } from './schema.js';

/** Async store contract (mirrors the Python `HistoryStore` ABC methods). */
export interface AsyncHistoryStore {
  pushRun(run: RunInput, results: TestResultInput[]): Promise<void>;
  queryFlaky(
    window: number,
    suite: string | null,
    minRate: number,
  ): Promise<FlakyQueryRow[]>;
  queryTimeline(testName: string): Promise<TimelineEntry[]>;
  querySummary(suite: string, runs: number): Promise<SummaryResult>;
  /**
   * OPTIONAL denominator probe (#508 Wave 4a). A backend that cannot report how
   * many runs it holds keeps benefit-of-the-doubt and never abstains: an
   * UNKNOWN denominator is not a zero one, and inventing an abstention would be
   * its own dishonesty. Implemented for the local NDJSON backend; the remote
   * Supabase backend has not grown one yet.
   */
  countRuns?(): Promise<number>;
  /**
   * OPTIONAL raw-record access (#711), carrying the same doctrine as
   * {@link AsyncHistoryStore.countRuns}: a backend that cannot hand back whole
   * run records simply does not implement it, and callers must treat its
   * absence as UNKNOWN rather than as an empty history.
   *
   * Three `analyze` sections — failure spikes, common failures and regression
   * candidates — are computed by walking whole records rather than by any
   * aggregate query, so they exist only where this does. Before #711 the engine
   * duck-typed for this method and quietly returned `[]` when it was missing,
   * which renders as a clean report against a backend that was never asked. The
   * engine now names those sections in `AnalysisResult.degraded` instead.
   *
   * Implemented for the local NDJSON backend (via `LocalAsyncAdapter`). The
   * remote Supabase backend has not grown one: it would need a real query plus
   * a row-to-`RunRecord` mapping, which is its own change.
   */
  readAll?(): Promise<RunRecord[]>;
}
