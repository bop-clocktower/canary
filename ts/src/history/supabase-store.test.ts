import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseProjectUrl, SupabaseHistoryStore } from './supabase-store.js';
import type { RunInput, TestResultInput } from './schema.js';

/**
 * Minimal chainable fake of the supabase-js query builder. Every filter method
 * returns the builder; awaiting it (thenable) resolves to `{ data, error }`
 * keyed by table. `upsert` resolves immediately and records the payload.
 */
function fakeClient(
  responses: Record<string, unknown[]>,
  errors: Record<string, { message: string; code?: string }> = {},
) {
  const upserts: Array<{ table: string; rows: unknown }> = [];
  const makeBuilder = (table: string) => {
    const failed = errors[table] ?? null;
    const builder = {
      select: () => builder,
      gte: () => builder,
      eq: () => builder,
      order: () => builder,
      limit: () => builder,
      upsert: (rows: unknown) => {
        upserts.push({ table, rows });
        return Promise.resolve({ data: null, error: failed });
      },
      then: (
        resolve: (v: { data: unknown[] | null; error: unknown }) => void,
      ) =>
        resolve(
          failed
            ? { data: null, error: failed }
            : { data: responses[table] ?? [], error: null },
        ),
    };
    return builder;
  };
  const client = { from: (table: string) => makeBuilder(table) };
  return { client: client as unknown as SupabaseClient, upserts };
}

const run: RunInput = {
  run_id: 'api-abc12345-1',
  suite: 'api',
  repo: 'acme/app',
  branch: 'main',
  commit_sha: 'abc12345',
  timestamp: '2026-06-01T00:00:00Z',
  total: 10,
  passed: 9,
  failed: 1,
  flaky: 0,
  skipped: 0,
};

describe('parseProjectUrl', () => {
  it('passes through an https project url', () => {
    expect(parseProjectUrl('https://proj.supabase.co')).toBe(
      'https://proj.supabase.co',
    );
  });

  it('extracts the host from a postgres connection url', () => {
    expect(
      parseProjectUrl('postgresql://user:pass@db.example.co:5432/postgres'),
    ).toBe('https://db.example.co');
  });

  it('redacts an unparseable url rather than leaking credentials', () => {
    expect(parseProjectUrl('not a url at all')).toBe(
      '<redacted-unparseable-url>',
    );
  });
});

describe('SupabaseHistoryStore', () => {
  it('upserts the run, and test rows when present, truncating long error_text', () => {
    const { client, upserts } = fakeClient({});
    const store = new SupabaseHistoryStore('https://x.supabase.co', client);
    const results: TestResultInput[] = [
      {
        run_id: run.run_id,
        suite: 'api',
        repo: 'acme/app',
        test_name: 't',
        test_file: 'f',
        status: 'failed',
        error_text: 'x'.repeat(2500),
      },
    ];
    return store.pushRun(run, results).then(() => {
      expect(upserts.map((u) => u.table)).toEqual([
        'canary_runs',
        'canary_test_results',
      ]);
      const rows = upserts[1]!.rows as Array<Record<string, unknown>>;
      expect((rows[0]!.error_text as string).length).toBe(2000);
    });
  });

  it('skips the test-results upsert when there are no results', async () => {
    const { client, upserts } = fakeClient({});
    const store = new SupabaseHistoryStore('https://x.supabase.co', client);
    await store.pushRun(run, []);
    expect(upserts.map((u) => u.table)).toEqual(['canary_runs']);
  });

  it('queryFlaky returns rows from the flake-summary view', async () => {
    const { client } = fakeClient({
      canary_flake_summary: [{ test_name: 't', flake_rate_pct: 40 }],
    });
    const store = new SupabaseHistoryStore('https://x.supabase.co', client);
    const rows = await store.queryFlaky(30, 'api', 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.test_name).toBe('t');
  });

  it('queryFlaky tolerates a suite filter and empty data', async () => {
    const { client } = fakeClient({});
    const store = new SupabaseHistoryStore('https://x.supabase.co', client);
    expect(await store.queryFlaky(30, null, 10)).toEqual([]);
  });

  it('queryTimeline flattens the embedded canary_runs join', async () => {
    const { client } = fakeClient({
      canary_test_results: [
        {
          run_id: 'r1',
          suite: 'api',
          status: 'failed',
          failure_category: 'timeout',
          error_text: 'boom',
          retry_count: 2,
          canary_runs: {
            branch: 'main',
            commit_sha: 'deadbeef',
            timestamp: '2026-06-01',
          },
        },
      ],
    });
    const store = new SupabaseHistoryStore('https://x.supabase.co', client);
    const timeline = await store.queryTimeline('t');
    expect(timeline[0]).toEqual({
      run_id: 'r1',
      suite: 'api',
      branch: 'main',
      commit_sha: 'deadbeef',
      timestamp: '2026-06-01',
      status: 'failed',
      failure_category: 'timeout',
      error_text: 'boom',
      retry_count: 2,
    });
  });

  it('querySummary reverses newest-first rows and averages pass rate', async () => {
    const { client } = fakeClient({
      canary_runs: [
        { run_id: 'r2', passed: 50, total: 100 },
        { run_id: 'r1', passed: 100, total: 100 },
      ],
    });
    const store = new SupabaseHistoryStore('https://x.supabase.co', client);
    const summary = await store.querySummary('api', 2);
    expect(summary.total_runs).toBe(2);
    expect(summary.avg_pass_rate).toBe(75.0);
    // reversed → oldest (r1) first
    expect(summary.runs?.[0]?.run_id).toBe('r1');
  });

  it('querySummary returns the empty shape when no rows', async () => {
    const { client } = fakeClient({});
    const store = new SupabaseHistoryStore('https://x.supabase.co', client);
    expect(await store.querySummary('api', 5)).toEqual({
      suite: 'api',
      total_runs: 0,
      avg_pass_rate: 0.0,
    });
  });
});

/**
 * #1057 finding 6 — a failed request must not read as a clean, empty result.
 *
 * supabase-js never throws on a query failure: it returns `{ data, error }` and
 * leaves the verdict to the caller. Every method here used to destructure only
 * `data`, so a 401 from a bad anon key, a dropped connection and a genuinely
 * empty table all produced the same reassuring answer — "no flaky tests",
 * "clean history", "run recorded". The error half carried the only evidence
 * that nothing had actually been measured, and it was discarded.
 *
 * Each test below asserts the error reaches the caller. `queryFlaky` is the
 * one with the sharpest consequence: `[]` is exactly what a healthy suite
 * returns, so an auth failure reported that way is indistinguishable from good
 * news.
 */
describe('SupabaseHistoryStore surfaces request failures (#1057)', () => {
  const authFailure = { message: 'JWT expired', code: 'PGRST301' };

  it('queryFlaky throws instead of reporting zero flaky tests', async () => {
    const { client } = fakeClient({}, { canary_flake_summary: authFailure });
    const store = new SupabaseHistoryStore('https://x.supabase.co', client);
    await expect(store.queryFlaky(30, null, 10)).rejects.toThrow(/JWT expired/);
  });

  it('queryTimeline throws instead of reporting an empty timeline', async () => {
    const { client } = fakeClient({}, { canary_test_results: authFailure });
    const store = new SupabaseHistoryStore('https://x.supabase.co', client);
    await expect(store.queryTimeline('t')).rejects.toThrow(/JWT expired/);
  });

  it('querySummary throws instead of reporting total_runs: 0', async () => {
    const { client } = fakeClient({}, { canary_runs: authFailure });
    const store = new SupabaseHistoryStore('https://x.supabase.co', client);
    await expect(store.querySummary('api', 5)).rejects.toThrow(/JWT expired/);
  });

  it('pushRun throws instead of reporting a successful write', async () => {
    const { client } = fakeClient({}, { canary_runs: authFailure });
    const store = new SupabaseHistoryStore('https://x.supabase.co', client);
    await expect(store.pushRun(run, [])).rejects.toThrow(/JWT expired/);
  });

  it('names the table so the failure is actionable', async () => {
    const { client } = fakeClient({}, { canary_flake_summary: authFailure });
    const store = new SupabaseHistoryStore('https://x.supabase.co', client);
    await expect(store.queryFlaky(30, null, 10)).rejects.toThrow(
      /canary_flake_summary/,
    );
  });
});

/**
 * #1057 finding 6, the other half — an absent `SUPABASE_ANON_KEY` used to
 * default to `''`, which `createClient` accepts. The store constructed fine and
 * every request then failed auth at the server, where (before the tests above)
 * it was coalesced back into an empty result. Failing at construction makes the
 * missing credential the reported problem rather than a silent one.
 */
describe('SupabaseHistoryStore requires a credential (#1057)', () => {
  const KEY = 'SUPABASE_ANON_KEY';
  let prior: string | undefined;

  beforeEach(() => {
    prior = process.env[KEY];
  });
  afterEach(() => {
    if (prior === undefined) delete process.env[KEY];
    else process.env[KEY] = prior;
  });

  it('throws when the anon key is unset', () => {
    delete process.env[KEY];
    expect(() => new SupabaseHistoryStore('https://x.supabase.co')).toThrow(
      /SUPABASE_ANON_KEY/,
    );
  });

  it('throws when the anon key is empty', () => {
    process.env[KEY] = '';
    expect(() => new SupabaseHistoryStore('https://x.supabase.co')).toThrow(
      /SUPABASE_ANON_KEY/,
    );
  });

  it('rejects a whitespace-only key without echoing it', () => {
    process.env[KEY] = '   \t  ';
    let message = '';
    try {
      new SupabaseHistoryStore('https://x.supabase.co');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/SUPABASE_ANON_KEY/);
    expect(message).not.toMatch(/\t/);
  });

  it('does not require the key when a client is injected', () => {
    delete process.env[KEY];
    const { client } = fakeClient({});
    expect(
      () => new SupabaseHistoryStore('https://x.supabase.co', client),
    ).not.toThrow();
  });
});
