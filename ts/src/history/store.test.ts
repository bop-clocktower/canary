import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalAsyncAdapter, makeStore } from './store.js';
import { SupabaseHistoryStore } from './supabase-store.js';
import type { RunInput } from './schema.js';

const ENV_KEY = 'CANARY_HISTORY_DB_URL';

describe('makeStore', () => {
  const original = process.env[ENV_KEY];
  const originalKey = process.env.SUPABASE_ANON_KEY;
  beforeEach(() => {
    // supabase-js createClient() requires a non-empty key even with no network
    // (a behaviour difference from supabase-py, which tolerated an empty key).
    process.env.SUPABASE_ANON_KEY = 'test-anon-key';
  });
  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
    if (originalKey === undefined) delete process.env.SUPABASE_ANON_KEY;
    else process.env.SUPABASE_ANON_KEY = originalKey;
  });

  it('returns a local adapter when no db-url is configured', () => {
    delete process.env[ENV_KEY];
    expect(makeStore(undefined, join(tmpdir(), 'h.jsonl'))).toBeInstanceOf(
      LocalAsyncAdapter,
    );
  });

  it('returns a Supabase store when a db-url arg is given', () => {
    delete process.env[ENV_KEY];
    expect(makeStore('https://proj.supabase.co')).toBeInstanceOf(
      SupabaseHistoryStore,
    );
  });

  it('falls back to CANARY_HISTORY_DB_URL from the environment', () => {
    process.env[ENV_KEY] = 'https://env-proj.supabase.co';
    expect(makeStore()).toBeInstanceOf(SupabaseHistoryStore);
  });
});

describe('LocalAsyncAdapter (async surface over the sync NDJSON store)', () => {
  const run: RunInput = {
    run_id: 'api-abc12345-1',
    suite: 'api',
    repo: 'acme/app',
    branch: 'main',
    commit_sha: 'abc12345',
    timestamp: '2026-06-01T00:00:00Z',
    total: 10,
    passed: 9,
    failed: 0,
    flaky: 1,
    skipped: 0,
  };

  it('round-trips a pushed run through the query methods', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'canary-store-'));
    const path = join(dir, 'history-v2.jsonl');
    const store = makeStore(undefined, path);

    await store.pushRun(run, [
      {
        run_id: run.run_id,
        suite: 'api',
        repo: 'acme/app',
        test_name: 'test_login',
        test_file: 'tests/test_login.py',
        status: 'flaky',
      },
    ]);

    const flaky = await store.queryFlaky(30, 'api', 10);
    expect(flaky[0]?.test_name).toBe('test_login');
    expect(flaky[0]?.flake_rate_pct).toBe(100.0);

    const timeline = await store.queryTimeline('test_login');
    expect(timeline).toHaveLength(1);

    const summary = await store.querySummary('api', 30);
    expect(summary.total_runs).toBe(1);
  });

  it('is idempotent — a duplicate run_id is not appended twice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'canary-store-'));
    const path = join(dir, 'history-v2.jsonl');
    const store = makeStore(undefined, path);
    await store.pushRun(run, []);
    await store.pushRun(run, []);
    const summary = await store.querySummary('api', 30);
    expect(summary.total_runs).toBe(1);
  });
});
