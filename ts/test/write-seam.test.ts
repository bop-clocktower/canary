/**
 * Write-seam parity: a record written by the TS store must be byte-compatible
 * with what the Python `LocalHistoryStore` writes and reads.
 *
 * CI-safe direction (this file): assert TS `serializeLocalRecord` /​ `pushRun`
 * produces the exact object Python's `asdict` produces — captured as a golden
 * fixture by `scripts/read_ts_written_history.py golden`. No Python needed at
 * test time.
 *
 * Reverse direction (Python reads a TS-written file) is verified locally with
 * `python scripts/read_ts_written_history.py read <path>` — not run in the
 * node-only CI job.
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { NdjsonHistoryStore } from '../src/history/ndjson-store.js';
import {
  serializeLocalRecord,
  type RunInput,
  type TestResultInput,
} from '../src/history/schema.js';

// MUST stay in sync with the fixed input in scripts/read_ts_written_history.py.
const run: RunInput = {
  run_id: 'api-abc12345-1700000000',
  suite: 'api',
  repo: 'acme/app',
  branch: 'main',
  commit_sha: 'abc12345def',
  timestamp: '2026-06-01T00:00:00Z',
  total: 10,
  passed: 8,
  failed: 1,
  flaky: 1,
  skipped: 0,
};

const results: TestResultInput[] = [
  {
    run_id: 'api-abc12345-1700000000',
    suite: 'api',
    repo: 'acme/app',
    test_name: 'test_login',
    test_file: 'tests/test_login.py',
    status: 'flaky',
  },
];

const goldenPath = fileURLToPath(
  new URL('./fixtures/history-write-golden.json', import.meta.url),
);
const golden = JSON.parse(readFileSync(goldenPath, 'utf-8')) as unknown;

describe('write-seam parity with Python', () => {
  it('serializeLocalRecord equals the Python asdict golden', () => {
    expect(serializeLocalRecord(run, results)).toEqual(golden);
  });

  it('pushRun writes a JSON line that parses to the golden record', () => {
    const dir = mkdtempSync(join(tmpdir(), 'canary-seam-'));
    const path = join(dir, 'history-v2.jsonl');
    const store = new NdjsonHistoryStore(path);

    store.pushRun(run, results);

    const line = readFileSync(path, 'utf-8').trim();
    expect(JSON.parse(line)).toEqual(golden);

    // And the TS reader reads its own write back correctly.
    const flaky = store.queryFlaky(30, 'api', 0);
    expect(flaky[0]?.test_name).toBe('test_login');
    expect(flaky[0]?.flake_rate_pct).toBe(100.0);
  });
});
