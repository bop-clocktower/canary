/**
 * History store factory + the async store contract.
 *
 * Port of `agent/history/store.py` (`HistoryStore` ABC + `make_store`).
 *
 * DISCOVERED BOUNDARY CONSTRAINT (differs from Python): the Python stores are
 * synchronous because `supabase-py`'s `.execute()` is blocking. The JS SDK
 * (`@supabase/supabase-js`) is Promise-based, so a remote store cannot expose
 * synchronous queries. This module therefore defines an ASYNC store contract
 * (`AsyncHistoryStore`) that `makeStore` returns. The analysis pilot's
 * synchronous `NdjsonHistoryStore` is left untouched (the analysis engine reads
 * it directly); here it is wrapped in a thin async adapter so both backends
 * present one uniform async surface.
 */

import type { TimelineEntry } from './record.js';
import {
  NdjsonHistoryStore,
  type FlakyQueryRow,
  type SummaryResult,
} from './ndjson-store.js';
import type { RunInput, TestResultInput } from './schema.js';
import { SupabaseHistoryStore } from './supabase-store.js';

const DEFAULT_NDJSON_PATH = 'test-results/reports/history-v2.jsonl';

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
}

/** Async adapter over the synchronous local NDJSON store. */
export class LocalAsyncAdapter implements AsyncHistoryStore {
  constructor(private readonly inner: NdjsonHistoryStore) {}

  async pushRun(run: RunInput, results: TestResultInput[]): Promise<void> {
    this.inner.pushRun(run, results);
  }

  async queryFlaky(
    window: number,
    suite: string | null,
    minRate: number,
  ): Promise<FlakyQueryRow[]> {
    return this.inner.queryFlaky(window, suite, minRate);
  }

  async queryTimeline(testName: string): Promise<TimelineEntry[]> {
    return this.inner.queryTimeline(testName);
  }

  async querySummary(suite: string, runs: number): Promise<SummaryResult> {
    return this.inner.querySummary(suite, runs);
  }
}

/**
 * Return a Supabase-backed store when a db-url is configured (arg then
 * `CANARY_HISTORY_DB_URL`), else a local NDJSON store. Mirrors `make_store`.
 */
export function makeStore(
  dbUrl?: string,
  ndjsonPath?: string,
): AsyncHistoryStore {
  const resolvedUrl = dbUrl ?? process.env.CANARY_HISTORY_DB_URL;
  if (resolvedUrl) return new SupabaseHistoryStore(resolvedUrl);
  return new LocalAsyncAdapter(
    new NdjsonHistoryStore(ndjsonPath ?? DEFAULT_NDJSON_PATH),
  );
}
