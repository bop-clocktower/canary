/**
 * Supabase-backed history store.
 *
 * Port of `agent/history/supabase_store.py`, using `@supabase/supabase-js`.
 * The JS SDK is Promise-based, so every method is async (see the boundary note
 * in `store.ts`). The client is injectable so tests can mock it — no live
 * network is ever required.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { def } from '../util/coalesce.js';
import { round1 } from '../util/round.js';
import type { TimelineEntry } from './record.js';
import type { FlakyQueryRow, SummaryResult } from './ndjson-store.js';
import type { AsyncHistoryStore } from './store.js';
import {
  serializeRun,
  serializeTestResult,
  type RunInput,
  type TestResultInput,
} from './schema.js';

const ERROR_TEXT_MAX = 2000;

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

  constructor(dbUrl: string, client?: SupabaseClient) {
    this.client =
      client ??
      createClient(
        parseProjectUrl(dbUrl),
        def(process.env.SUPABASE_ANON_KEY, ''),
      );
  }

  async pushRun(run: RunInput, results: TestResultInput[]): Promise<void> {
    await this.client.from('canary_runs').upsert(serializeRun(run));
    if (results.length > 0) {
      await this.client
        .from('canary_test_results')
        .upsert(results.map(toResultRow));
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
    const { data } = await query;
    return def(data, []) as FlakyQueryRow[];
  }

  async queryTimeline(testName: string): Promise<TimelineEntry[]> {
    const { data } = await this.client
      .from('canary_test_results')
      .select(
        'run_id, suite, status, failure_category, error_text, retry_count, ' +
          'canary_runs!inner(branch, commit_sha, timestamp)',
      )
      .eq('test_name', testName)
      .order('canary_runs(timestamp)');
    return def(data as Record<string, unknown>[] | null, []).map(
      flattenTimelineRow,
    );
  }

  async querySummary(suite: string, runs: number): Promise<SummaryResult> {
    const { data } = await this.client
      .from('canary_runs')
      .select('run_id, branch, timestamp, passed, failed, flaky, total')
      .eq('suite', suite)
      .order('timestamp', { ascending: false })
      .limit(runs);
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
