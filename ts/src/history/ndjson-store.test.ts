import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NdjsonHistoryStore } from './ndjson-store.js';
import {
  LEGACY_UNVERSIONED_SCHEMA_VERSION,
  SCHEMA_VERSION,
  resolveSchemaVersion,
} from './record.js';
import type { RunRecord } from './record.js';

let dir: string;

function writeHistory(lines: object[], raw?: string): string {
  const path = join(dir, 'history-v2.jsonl');
  const body = raw ?? lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  writeFileSync(path, body, 'utf-8');
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canary-ndjson-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('NdjsonHistoryStore.readAll', () => {
  it('returns [] when the file does not exist', () => {
    const store = new NdjsonHistoryStore(join(dir, 'missing.jsonl'));
    expect(store.readAll()).toEqual([]);
  });

  it('parses records and skips blank lines', () => {
    const path = writeHistory(
      [],
      `{"run_id":"r1","suite":"api"}\n\n  \n{"run_id":"r2","suite":"api"}\n`,
    );
    const store = new NdjsonHistoryStore(path);
    expect(store.readAll().map((r) => r.run_id)).toEqual(['r1', 'r2']);
  });

  it('tolerates a missing schema_version (legacy pre-#701 rows)', () => {
    const store = new NdjsonHistoryStore(
      writeHistory([{ run_id: 'r1', suite: 'api' }]),
    );
    expect(store.readAll()).toHaveLength(1);
  });

  it('accepts an explicit current schema_version', () => {
    const store = new NdjsonHistoryStore(
      writeHistory([{ run_id: 'r1', suite: 'api', schema_version: 2 }]),
    );
    expect(store.readAll()).toHaveLength(1);
  });

  it('throws on an unknown schema_version', () => {
    const store = new NdjsonHistoryStore(
      writeHistory([{ run_id: 'r1', suite: 'api', schema_version: 99 }]),
    );
    expect(() => store.readAll()).toThrow(/schema_version 99/);
  });

  it('throws on malformed JSON', () => {
    const store = new NdjsonHistoryStore(writeHistory([], 'not json\n'));
    expect(() => store.readAll()).toThrow();
  });
});

// #701: an unversioned row is resolved to the version it was actually written
// at, NOT to whatever the current version happens to be. The two are the same
// number today, which is exactly why this needs a test: the day SCHEMA_VERSION
// bumps, the difference is silent misinterpretation vs a loud refusal.
describe('resolveSchemaVersion', () => {
  it('resolves an unversioned row to the legacy version', () => {
    expect(resolveSchemaVersion({ run_id: 'r1', suite: 'api' })).toBe(
      LEGACY_UNVERSIONED_SCHEMA_VERSION,
    );
  });

  it('pins the legacy version to 2 — the only version ever written unstamped', () => {
    // Deliberately a literal, not SCHEMA_VERSION. Aliasing this constant to
    // the current version would re-introduce #701 at the next bump.
    expect(LEGACY_UNVERSIONED_SCHEMA_VERSION).toBe(2);
  });

  it('honours an explicit version over the legacy default', () => {
    expect(
      resolveSchemaVersion({ run_id: 'r1', suite: 'api', schema_version: 99 }),
    ).toBe(99);
  });
});

describe('NdjsonHistoryStore.pushRun', () => {
  const run = {
    run_id: 'api-1',
    suite: 'api',
    repo: 'acme/app',
    branch: 'main',
    commit_sha: 'abc12345',
    timestamp: '2026-06-01T00:00:00Z',
    total: 1,
    passed: 1,
    failed: 0,
    flaky: 0,
    skipped: 0,
  };
  const results = [
    {
      run_id: 'api-1',
      suite: 'api',
      repo: 'acme/app',
      test_name: 'test_login',
      test_file: 'tests/test_login.py',
      status: 'passed',
    },
  ];

  it('stamps schema_version on the row it appends (#701)', () => {
    const path = join(dir, 'history-v2.jsonl');
    const store = new NdjsonHistoryStore(path);
    store.pushRun(run, results);

    const line = readFileSync(path, 'utf-8').trim();
    expect((JSON.parse(line) as RunRecord).schema_version).toBe(SCHEMA_VERSION);
  });

  it('reads back a row it wrote itself', () => {
    const store = new NdjsonHistoryStore(join(dir, 'history-v2.jsonl'));
    store.pushRun(run, results);
    expect(store.readAll().map((r) => r.run_id)).toEqual(['api-1']);
  });
});

describe('NdjsonHistoryStore.queryFlaky', () => {
  const records = [
    {
      run_id: 'r1',
      suite: 'api',
      tests: [
        { test_name: 'a', status: 'flaky', area: 'members' },
        { test_name: 'b', status: 'passed' },
      ],
    },
    {
      run_id: 'r2',
      suite: 'api',
      tests: [
        { test_name: 'a', status: 'passed' },
        { test_name: 'b', status: 'failed' },
      ],
    },
  ];

  it('aggregates flake rate and filters by min rate, sorted desc', () => {
    const store = new NdjsonHistoryStore(writeHistory(records));
    const rows = store.queryFlaky(30, null, 10.0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.test_name).toBe('a');
    expect(rows[0]!.flake_rate_pct).toBe(50.0); // 1 flaky / 2 runs
    expect(rows[0]!.area).toBe('members');
  });

  it('filters by suite and honors the window', () => {
    const store = new NdjsonHistoryStore(writeHistory(records));
    expect(store.queryFlaky(30, 'nope', 10.0)).toEqual([]);
    // window=1 keeps only r2 → test a passed once → 0% → below threshold
    expect(store.queryFlaky(1, 'api', 10.0)).toEqual([]);
  });
});

describe('NdjsonHistoryStore.queryTimeline / querySummary', () => {
  const records = [
    {
      run_id: 'r2',
      suite: 'api',
      timestamp: '2026-06-02T00:00:00Z',
      passed: 8,
      failed: 2,
      flaky: 0,
      total: 10,
      commit_sha: 'bbb',
      tests: [{ test_name: 'a', status: 'failed' }],
    },
    {
      run_id: 'r1',
      suite: 'api',
      timestamp: '2026-06-01T00:00:00Z',
      passed: 10,
      failed: 0,
      flaky: 0,
      total: 10,
      commit_sha: 'aaa',
      tests: [{ test_name: 'a', status: 'passed' }],
    },
    {
      run_id: 'r3',
      suite: 'web',
      timestamp: '2026-06-03T00:00:00Z',
      passed: 5,
      failed: 5,
      flaky: 0,
      total: 10,
      tests: [{ test_name: 'a', status: 'failed' }],
    },
  ];

  it('returns a timeline sorted by timestamp', () => {
    const store = new NdjsonHistoryStore(writeHistory(records));
    const tl = store.queryTimeline('a');
    expect(tl.map((e) => e.run_id)).toEqual(['r1', 'r2', 'r3']);
    expect(tl[0]!.status).toBe('passed');
  });

  it('summarises a suite with per-run rows and average pass rate', () => {
    const store = new NdjsonHistoryStore(writeHistory(records));
    const s = store.querySummary('api', 30);
    expect(s.total_runs).toBe(2);
    expect(s.avg_pass_rate).toBe(90.0); // (100 + 80) / 2
    expect(s.runs).toHaveLength(2);
  });

  it('returns an empty summary for an unknown suite', () => {
    const store = new NdjsonHistoryStore(writeHistory(records));
    expect(store.querySummary('nope', 30)).toEqual({
      suite: 'nope',
      total_runs: 0,
      avg_pass_rate: 0.0,
    });
  });

  it('averages to 0 when present runs all have total=0', () => {
    const store = new NdjsonHistoryStore(
      writeHistory([
        { run_id: 'z1', suite: 'empty', total: 0, passed: 0 },
        { run_id: 'z2', suite: 'empty', total: 0, passed: 0 },
      ]),
    );
    const s = store.querySummary('empty', 30);
    expect(s.total_runs).toBe(2);
    expect(s.avg_pass_rate).toBe(0.0);
  });
});
