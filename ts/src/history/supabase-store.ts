/**
 * Supabase-backed history store.
 *
 * Uses `@supabase/supabase-js`.
 * The JS SDK is Promise-based, so every method is async (see the boundary note
 * in `store.ts`). The client is injectable so tests can mock it — no live
 * network is ever required.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { def } from '../util/coalesce.js';
import { round1 } from '../util/round.js';
import type { TimelineEntry } from './record.js';
import type { FlakyQueryRow, SummaryResult } from './ndjson-store.js';
import type { AsyncHistoryStore } from './async-store.js';
import {
  serializeRun,
  serializeTestResult,
  type RunInput,
  type TestResultInput,
} from './schema.js';

const ERROR_TEXT_MAX = 2000;

/**
 * Shape of the `{ data, error }` pair every supabase-js call resolves to.
 * Declared locally rather than imported because the SDK's generic result types
 * are parameterised over the table schema, which this store does not model.
 */
interface SupabaseResult<T> {
  data: T | null;
  error: { message?: string; code?: string } | null;
}

/**
 * Return `data`, or throw if the request failed (#1057).
 *
 * supabase-js does not throw on a failed query — it resolves to
 * `{ data: null, error }` and leaves the verdict to the caller. Discarding
 * `error` and coalescing `data` to `[]` therefore makes an expired JWT, a
 * dropped connection and a genuinely empty table produce the same answer, and
 * that answer is the reassuring one: no flaky tests, clean history, run
 * recorded. A zero denominator is an abstention, not a pass.
 *
 * `table` is named in the message so the failure points at a place. The
 * credential is never part of the message.
 */
function unwrap<T>(table: string, result: SupabaseResult<T>): T | null {
  const { data, error } = result;
  if (error) {
    const detail = error.message ?? 'no message';
    const code = error.code ? ` [${error.code}]` : '';
    throw new Error(`Supabase request on "${table}" failed${code}: ${detail}`);
  }
  return data;
}

/**
 * Resolve the Supabase project URL. A plain `https://…` url passes through; a
 * `postgresql+asyncpg://user:pass@host/db` url yields `https://<host>`. Never
 * returns the raw connection string (it embeds credentials). Pure + exported
 * for direct parity testing against Python `_parse_project_url`.
 */
export function parseProjectUrl(dbUrl: string): string {
  if (dbUrl.startsWith('https://')) return dbUrl;
  try {
    const host = new URL(dbUrl).hostname;
    return `https://${host}`;
  } catch {
    return '<redacted-unparseable-url>';
  }
}

function toResultRow(t: TestResultInput): Record<string, unknown> {
  const row = serializeTestResult(t);
  const err = row.error_text;
  if (typeof err === 'string' && err.length > ERROR_TEXT_MAX) {
    row.error_text = err.slice(0, ERROR_TEXT_MAX);
  }
  return row;
}

function flattenTimelineRow(row: Record<string, unknown>): TimelineEntry {
  const runInfo = def(
    row.canary_runs as Record<string, unknown> | undefined,
    {},
  );
  return {
    run_id: String(def(row.run_id, '')),
    suite: String(def(row.suite, '')),
    branch: String(def(runInfo.branch, '')),
    commit_sha: String(def(runInfo.commit_sha, '')),
    timestamp: String(def(runInfo.timestamp, '')),
    status: String(def(row.status, '')),
    failure_category:
      (def(row.failure_category, null) as string | null) ?? null,
    error_text: (def(row.error_text, null) as string | null) ?? null,
    retry_count: Number(def(row.retry_count, 0)),
  };
}

export class SupabaseHistoryStore implements AsyncHistoryStore {
  private readonly client: SupabaseClient;

  /**
   * @param client Inject a client to bypass credential resolution entirely —
   *               tests do this, and it is the only path that needs no key.
   * @throws If no client is injected and `SUPABASE_ANON_KEY` is missing or
   *         blank. It used to default to `''`, which `createClient` accepts:
   *         the store built fine and every request then failed auth at the
   *         server, where the old coalescing turned it back into a clean empty
   *         result (#1057). Failing here makes the missing credential the
   *         reported problem.
   */
  constructor(dbUrl: string, client?: SupabaseClient) {
    if (client) {
      this.client = client;
      return;
    }
    const key = def(process.env.SUPABASE_ANON_KEY, '').trim();
    if (key === '') {
      throw new Error(
        'SUPABASE_ANON_KEY is not set (or is blank), so the history store ' +
          'cannot authenticate. Set it, or pass a client explicitly.',
      );
    }
    this.client = createClient(parseProjectUrl(dbUrl), key);
  }

  async pushRun(run: RunInput, results: TestResultInput[]): Promise<void> {
    unwrap(
      'canary_runs',
      await this.client.from('canary_runs').upsert(serializeRun(run)),
    );
    if (results.length > 0) {
      unwrap(
        'canary_test_results',
        await this.client
          .from('canary_test_results')
          .upsert(results.map(toResultRow)),
      );
    }
  }

  async queryFlaky(
    _window: number,
    suite: string | null,
    minRate: number,
  ): Promise<FlakyQueryRow[]> {
    let query = this.client
      .from('canary_flake_summary')
      .select('*')
      .gte('flake_rate_pct', minRate)
      .order('flake_rate_pct', { ascending: false });
    if (suite) query = query.eq('suite', suite);
    const data = unwrap('canary_flake_summary', await query);
    return def(data, []) as FlakyQueryRow[];
  }

  async queryTimeline(testName: string): Promise<TimelineEntry[]> {
    const data = unwrap(
      'canary_test_results',
      await this.client
        .from('canary_test_results')
        .select(
          'run_id, suite, status, failure_category, error_text, retry_count, ' +
            'canary_runs!inner(branch, commit_sha, timestamp)',
        )
        .eq('test_name', testName)
        .order('canary_runs(timestamp)'),
    );
    return def(data as Record<string, unknown>[] | null, []).map(
      flattenTimelineRow,
    );
  }

  async querySummary(suite: string, runs: number): Promise<SummaryResult> {
    const data = unwrap(
      'canary_runs',
      await this.client
        .from('canary_runs')
        .select('run_id, branch, timestamp, passed, failed, flaky, total')
        .eq('suite', suite)
        .order('timestamp', { ascending: false })
        .limit(runs),
    );
    const recent = [...def(data, [])].reverse();
    if (recent.length === 0) {
      return { suite, total_runs: 0, avg_pass_rate: 0.0 };
    }
    const rates = recent
      .filter((r) => Number(def(r.total, 0)) > 0)
      .map((r) => (Number(r.passed) / Number(r.total)) * 100);
    const avg =
      rates.length > 0
        ? round1(rates.reduce((a, b) => a + b, 0) / rates.length)
        : 0.0;
    return {
      suite,
      total_runs: recent.length,
      avg_pass_rate: avg,
      runs: recent,
    };
  }
}
