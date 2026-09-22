/**
 * CLI coverage for `canary history trim` (#1024).
 *
 * The verb exists because retention had nowhere to live: `history record` is
 * append-only and unbounded by contract (proposal 460), and canary's own CI
 * caches the whole store after every run, so the cache entry grew with the
 * history. Trimming is therefore a separate, explicit operation a caller
 * invokes -- never something `record` does behind a consumer's back.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

const HISTORY_REL = join('test-results', 'reports', 'history-v2.jsonl');

/** Seed `count` runs, oldest first, one minute apart. */
function seed(tmp: string, count: number, rel = HISTORY_REL): string {
  const path = join(tmp, rel);
  mkdirSync(dirname(path), { recursive: true });
  const lines: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    lines.push(
      JSON.stringify({
        run_id: `run-${String(i).padStart(3, '0')}`,
        suite: 'ts-engine',
        timestamp: `2026-09-21T00:${String(i % 60).padStart(2, '0')}:00Z`,
        total: 1,
        passed: 1,
        failed: 0,
        flaky: 0,
        tests: [{ test_name: 'a test', status: 'passed' }],
      }),
    );
  }
  writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
  return path;
}

function runIds(path: string): string[] {
  return readFileSync(path, 'utf-8')
    .trim()
    .split('\n')
    .map((l) => (JSON.parse(l) as { run_id: string }).run_id);
}

describe('canary history trim', () => {
  it('drops the oldest runs and says what it removed', async () => {
    const tmp = mkTmp();
    try {
      const path = seed(tmp, 14);
      const res = await invokeCanary(['history', 'trim', '--keep', '10'], {
        cwd: tmp,
      });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('14');
      expect(res.stdout).toContain('10');
      expect(runIds(path)).toEqual([
        'run-005',
        'run-006',
        'run-007',
        'run-008',
        'run-009',
        'run-010',
        'run-011',
        'run-012',
        'run-013',
        'run-014',
      ]);
    } finally {
      rmTmp(tmp);
    }
  });

  it('is a reported no-op at exactly the keep count', async () => {
    const tmp = mkTmp();
    try {
      const path = seed(tmp, 10);
      const before = readFileSync(path, 'utf-8');
      const res = await invokeCanary(['history', 'trim', '--keep', '10'], {
        cwd: tmp,
      });
      expect(res.code).toBe(0);
      expect(readFileSync(path, 'utf-8')).toBe(before);
    } finally {
      rmTmp(tmp);
    }
  });

  it('--json reports the before/after/removed denominators', async () => {
    const tmp = mkTmp();
    try {
      seed(tmp, 12);
      const res = await invokeCanary(
        ['history', 'trim', '--keep', '5', '--json'],
        { cwd: tmp },
      );
      expect(res.code).toBe(0);
      expect(JSON.parse(res.stdout)).toMatchObject({
        before: 12,
        after: 5,
        removed: 7,
        keep: 5,
      });
    } finally {
      rmTmp(tmp);
    }
  });

  it('trims a store at a non-default --path', async () => {
    const tmp = mkTmp();
    try {
      const rel = join('elsewhere', 'store.jsonl');
      const path = seed(tmp, 6, rel);
      const res = await invokeCanary(
        ['history', 'trim', '--keep', '2', '--path', rel],
        { cwd: tmp },
      );
      expect(res.code).toBe(0);
      expect(runIds(path)).toEqual(['run-005', 'run-006']);
    } finally {
      rmTmp(tmp);
    }
  });

  // An absent store is zero runs, which is already within any keep count. It
  // must not read as an error -- CI trims unconditionally after `record`.
  it('is a clean no-op when the store does not exist', async () => {
    const tmp = mkTmp();
    try {
      const res = await invokeCanary(
        ['history', 'trim', '--keep', '50', '--json'],
        { cwd: tmp },
      );
      expect(res.code).toBe(0);
      expect(JSON.parse(res.stdout)).toMatchObject({
        before: 0,
        after: 0,
        removed: 0,
      });
    } finally {
      rmTmp(tmp);
    }
  });

  it('rejects --keep 0 as a usage error rather than emptying the store', async () => {
    const tmp = mkTmp();
    try {
      const path = seed(tmp, 4);
      const res = await invokeCanary(['history', 'trim', '--keep', '0'], {
        cwd: tmp,
      });
      expect(res.code).toBe(2);
      expect(runIds(path)).toHaveLength(4);
    } finally {
      rmTmp(tmp);
    }
  });

  it('requires --keep', async () => {
    const tmp = mkTmp();
    try {
      const res = await invokeCanary(['history', 'trim'], { cwd: tmp });
      expect(res.code).toBe(2);
    } finally {
      rmTmp(tmp);
    }
  });

  // Silently succeeding against a remote store would be a false green: the
  // caller asked for a bounded store and nothing would have been bounded.
  it('refuses when a remote store is configured, instead of no-opping', async () => {
    const tmp = mkTmp();
    try {
      const path = seed(tmp, 12);
      const res = await invokeCanary(['history', 'trim', '--keep', '5'], {
        cwd: tmp,
        env: { CANARY_HISTORY_DB_URL: 'postgresql://example/db' },
      });
      expect(res.code).toBe(1);
      expect(res.stdout + res.stderr).toMatch(/local/i);
      expect(runIds(path)).toHaveLength(12);
    } finally {
      rmTmp(tmp);
    }
  });
});
