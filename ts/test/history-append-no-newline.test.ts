/**
 * Appending to a local store whose last line has no trailing newline.
 *
 * `pushRun` appended `JSON.stringify(record) + '\n'` assuming the file ended in
 * a newline. A store written by another tool (or hand-edited) without one got
 * two records glued onto one line, and every later read of it failed.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { NdjsonHistoryStore } from '../src/history/ndjson-store.js';

describe('NdjsonHistoryStore.pushRun on a file with no final newline', () => {
  it('keeps the appended run on its own line', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'canary-nl-'));
    try {
      const path = join(tmp, 'h.jsonl');
      const existing = {
        schema_version: 2,
        run_id: 'r1',
        suite: 'api',
        timestamp: '2026-01-01T00:00:00+00:00',
        tests: [],
      };
      writeFileSync(path, JSON.stringify(existing)); // no trailing newline
      new NdjsonHistoryStore(path).pushRun(
        {
          run_id: 'r2',
          suite: 'api',
          repo: 'o/r',
          branch: 'main',
          commit_sha: 'abc',
          timestamp: '2026-01-02T00:00:00+00:00',
          total: 0,
          passed: 0,
          failed: 0,
          flaky: 0,
          skipped: 0,
        },
        [],
      );
      const lines = readFileSync(path, 'utf-8')
        .split('\n')
        .filter((l) => l.trim() !== '');
      expect(lines).toHaveLength(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
