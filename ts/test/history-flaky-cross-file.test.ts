/**
 * #1350: a test's flake identity is its FILE plus its name. vitest's
 * `fullName` carries no file, so `parse handles empty` in `a.test.ts` and in
 * `b.test.ts` share a name. Keyed on the name alone, a deterministic pass in
 * one file and a deterministic fail in the other read back as ONE test that
 * alternates -- a fabricated flake. Both surfaces that score flakes are pinned:
 * `NdjsonHistoryStore.queryFlaky` (the `flaky` commands) and ci-ready's
 * `flakeSignals`, which keyed on the name the same way.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { flakeSignals } from '../src/core/flake-signals.js';
import { NdjsonHistoryStore } from '../src/history/ndjson-store.js';
import type { RunInput, TestResultInput } from '../src/history/schema.js';

const NAME = 'parse handles empty';

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
    test_name: NAME,
    test_file: file,
    status,
  };
}

function storeWith(
  rows: (i: number) => TestResultInput[],
  runs = 6,
): NdjsonHistoryStore {
  const dir = mkdtempSync(join(tmpdir(), 'flaky-cross-file-'));
  dirs.push(dir);
  const store = new NdjsonHistoryStore(join(dir, 'history-v2.jsonl'));
  for (let i = 1; i <= runs; i++) store.pushRun(run(i), rows(i));
  return store;
}

describe('NdjsonHistoryStore.queryFlaky across files (#1350)', () => {
  it('reports no alternation for a deterministic pass and a deterministic fail in different files', () => {
    const store = storeWith((i) => [
      result(i, 'src/a.test.ts', 'passed'),
      result(i, 'src/b.test.ts', 'failed'),
    ]);
    const rows = store.queryFlaky(30, null, 10);
    expect(rows.filter((r) => r.alternating === true)).toEqual([]);
  });

  it('keeps one row per file, each with only its own results', () => {
    const store = storeWith((i) => [
      result(i, 'src/a.test.ts', i % 2 ? 'flaky' : 'passed'),
      result(i, 'src/b.test.ts', 'failed'),
    ]);
    const rows = store.queryFlaky(30, null, 0);
    const byFile = new Map(rows.map((r) => [r.test_file, r]));
    expect(byFile.get('src/a.test.ts')).toMatchObject({
      total_runs: 6,
      flake_count: 3,
      fail_count: 0,
    });
    expect(byFile.get('src/b.test.ts')).toMatchObject({
      total_runs: 6,
      flake_count: 0,
      fail_count: 6,
    });
  });

  it('still tracks one test across runs when its file is unchanged (control)', () => {
    const store = storeWith((i) => [
      result(i, 'src/a.test.ts', i % 2 ? 'passed' : 'failed'),
    ]);
    const rows = store.queryFlaky(30, null, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      test_file: 'src/a.test.ts',
      total_runs: 6,
    });
  });
});

describe('ci-ready flakeSignals across files (#1350)', () => {
  const runs = (a: string, b: (i: number) => string) =>
    Array.from({ length: 10 }, (_, i) => ({
      tests: [
        { test_name: NAME, test_file: 'src/a.test.ts', status: a },
        { test_name: NAME, test_file: 'src/b.test.ts', status: b(i) },
      ],
    }));

  it('finds no flake when each same-named test is deterministic in its own file', () => {
    expect(flakeSignals(runs('passed', () => 'failed')).size).toBe(0);
  });

  it('names the file when a flaking test shares its name with another file', () => {
    const signals = flakeSignals(
      runs('passed', (i) => (i % 2 ? 'passed' : 'failed')),
    );
    expect([...signals.keys()]).toEqual([`${NAME} (src/b.test.ts)`]);
  });

  it('keeps the bare name when only one file has it (control)', () => {
    const signals = flakeSignals([
      { tests: [{ test_name: 'solo', test_file: 'x.ts', status: 'flaky' }] },
    ]);
    expect([...signals.keys()]).toEqual(['solo']);
  });
});
