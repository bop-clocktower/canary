/**
 * `history push` with no remote store configured.
 *
 * Without a db-url the store factory falls back to a LOCAL NDJSON store at the
 * very file being pushed; its `pushRun` sees the run_id already present and
 * skips it silently, yet the command printed `Pushed run ...` and exited 0.
 * Nothing moved anywhere -- a false green. It must refuse instead, as `trim`
 * refuses the opposite mismatch.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

describe('history push without a remote store', () => {
  it('does not report success when no db-url is configured', async () => {
    const tmp = mkTmp();
    try {
      const path = join(tmp, 'h.jsonl');
      const record = {
        schema_version: 2,
        run_id: 'r-old',
        suite: 'api',
        repo: 'o/r',
        branch: 'main',
        commit_sha: 'abc',
        timestamp: '2026-01-01T00:00:00+00:00',
        total: 1,
        passed: 1,
        failed: 0,
        flaky: 0,
        skipped: 0,
        tests: [{ test_name: 't', status: 'passed' }],
      };
      writeFileSync(path, JSON.stringify(record) + '\n');
      const before = readFileSync(path, 'utf-8');
      const res = await invokeCanary(['history', 'push', path], { cwd: tmp });
      // The file is untouched: nothing was pushed anywhere.
      expect(readFileSync(path, 'utf-8')).toBe(before);
      expect(res.code).not.toBe(0);
    } finally {
      rmTmp(tmp);
    }
  });
});
