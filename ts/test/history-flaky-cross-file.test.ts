/**
 * `queryFlaky` must not merge same-named tests from different files.
 *
 * vitest's `fullName` is the describe chain plus the title -- it carries no
 * file -- so `parse handles empty` in `a.test.ts` and in `b.test.ts` are two
 * tests with one name. The NDJSON store keys its flake accumulator on
 * `test_name` alone, so a test that passes every run in one file and a test
 * that fails every run in the other read back as ONE row whose status
 * sequence alternates passed/failed: a fabricated alternating flake over two
 * perfectly deterministic tests (the read-side twin of #1294).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { NdjsonHistoryStore } from '../src/history/ndjson-store.js';
import type { RunInput, TestResultInput } from '../src/history/schema.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function run(i: number): RunInput {
  return {
    run_id: `r${i}`,
    suite: 'unit',
    repo: 'o/r',
    branch: 'main',
    commit_sha: `c${i}`,
    timestamp: `2026-01-0${i}T00:00:00+00:00`,
    total: 2,
    passed: 1,
    failed: 1,
    flaky: 0,
    skipped: 0,
  };
}

function result(i: number, file: string, status: string): TestResultInput {
  return {
    run_id: `r${i}`,
    suite: 'unit',
    repo: 'o/r',
    test_name: 'parse handles empty',
    test_file: file,
    status,
  };
}

describe('NdjsonHistoryStore.queryFlaky across files', () => {
  it('reports no alternation for a deterministic pass and a deterministic fail in different files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flaky-cross-file-'));
    dirs.push(dir);
    const store = new NdjsonHistoryStore(join(dir, 'history-v2.jsonl'));
    for (let i = 1; i <= 6; i++) {
      store.pushRun(run(i), [
        result(i, 'src/a.test.ts', 'passed'),
        result(i, 'src/b.test.ts', 'failed'),
      ]);
    }

    const rows = store.queryFlaky(30, null, 10);

    expect(rows.filter((r) => r.alternating === true)).toEqual([]);
  });
});
