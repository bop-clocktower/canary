/**
 * Branch coverage for `canary analyze`'s row-building fallbacks (#481).
 *
 * `analyze-cli.test.ts` ports the Python cases, which always seed a COMPLETE
 * history record. Real history files are not complete: a v1-migrated run has no
 * per-test rows, an aborted run has no counts, and a reporter that crashed
 * mid-write leaves fields absent. Those absences hit a row of `??` fallbacks
 * whose job is to keep the report numeric rather than rendering `undefined`.
 * The `--since` filter on both history-backed commands is covered here too.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

const HISTORY_REL = join('test-results', 'reports', 'history-v2.jsonl');

/** Write `records` as the local NDJSON store inside a fresh temp cwd. */
function cwdWith(records: unknown[]): string {
  const tmp = mkTmp();
  const path = join(tmp, HISTORY_REL);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf-8',
  );
  return tmp;
}

describe('analyze spikes over incomplete records', () => {
  it('defaults every absent count to 0 rather than emitting undefined', async () => {
    // A run with only a run_id -- every other field absent.
    const tmp = cwdWith([{ run_id: 'r1' }]);
    try {
      const res = await invokeCanary(['analyze', 'spikes', '--json'], {
        cwd: tmp,
      });
      expect(res.code).toBe(0);
      const rows = JSON.parse(res.stdout) as Record<string, unknown>[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        suite: '',
        timestamp: '',
        passed: 0,
        failed: 0,
        flaky: 0,
        total: 0,
      });
    } finally {
      rmTmp(tmp);
    }
  });

  it('--since keeps only runs at or after the cutoff', async () => {
    const tmp = cwdWith([
      { run_id: 'old', suite: 's', timestamp: '2026-01-01T00:00:00Z' },
      { run_id: 'new', suite: 's', timestamp: '2026-06-01T00:00:00Z' },
    ]);
    try {
      const res = await invokeCanary(
        ['analyze', 'spikes', '--json', '--since', '2026-03-01'],
        { cwd: tmp },
      );
      const rows = JSON.parse(res.stdout) as { timestamp: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.timestamp).toBe('2026-06-01T00:00:00Z');
    } finally {
      rmTmp(tmp);
    }
  });

  it('treats a run with no timestamp as older than any cutoff', async () => {
    const tmp = cwdWith([{ run_id: 'undated', suite: 's' }]);
    try {
      const res = await invokeCanary(
        ['analyze', 'spikes', '--json', '--since', '2020-01-01'],
        { cwd: tmp },
      );
      expect(JSON.parse(res.stdout)).toEqual([]);
    } finally {
      rmTmp(tmp);
    }
  });
});

describe('analyze common-failures over incomplete records', () => {
  it('defaults an absent category to "other" and an absent suite to empty', async () => {
    const tmp = cwdWith([
      {
        run_id: 'r1',
        timestamp: '2026-06-01T00:00:00Z',
        tests: [
          { test_name: 'test_pay', status: 'failed', error_text: 'boom' },
        ],
      },
    ]);
    try {
      const res = await invokeCanary(['analyze', 'common-failures', '--json'], {
        cwd: tmp,
      });
      const rows = JSON.parse(res.stdout) as Record<string, unknown>[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!['failure_category']).toBe('other');
      expect(rows[0]!['suite']).toBe('');
      expect(rows[0]!['error_text']).toBe('boom');
    } finally {
      rmTmp(tmp);
    }
  });

  it('treats a run with no tests key as contributing no rows', async () => {
    const tmp = cwdWith([
      { run_id: 'r1', suite: 's', timestamp: '2026-06-01T00:00:00Z' },
    ]);
    try {
      const res = await invokeCanary(['analyze', 'common-failures', '--json'], {
        cwd: tmp,
      });
      expect(JSON.parse(res.stdout)).toEqual([]);
    } finally {
      rmTmp(tmp);
    }
  });

  it('ignores a failed test that carries no error text', async () => {
    const tmp = cwdWith([
      {
        run_id: 'r1',
        suite: 's',
        timestamp: '2026-06-01T00:00:00Z',
        tests: [
          { test_name: 'silent', status: 'failed' },
          { test_name: 'passing', status: 'passed', error_text: 'ignored' },
        ],
      },
    ]);
    try {
      const res = await invokeCanary(['analyze', 'common-failures', '--json'], {
        cwd: tmp,
      });
      expect(JSON.parse(res.stdout)).toEqual([]);
    } finally {
      rmTmp(tmp);
    }
  });

  it('counts a flaky test alongside a failed one', async () => {
    const tmp = cwdWith([
      {
        run_id: 'r1',
        suite: 's',
        timestamp: '2026-06-01T00:00:00Z',
        tests: [
          { test_name: 'f', status: 'flaky', error_text: 'TimeoutError' },
        ],
      },
    ]);
    try {
      const res = await invokeCanary(['analyze', 'common-failures', '--json'], {
        cwd: tmp,
      });
      const rows = JSON.parse(res.stdout) as { test_name: string }[];
      expect(rows.map((r) => r.test_name)).toEqual(['f']);
    } finally {
      rmTmp(tmp);
    }
  });

  it('--since filters the runs it reads rows from', async () => {
    const failing = (id: string, timestamp: string) => ({
      run_id: id,
      suite: 's',
      timestamp,
      tests: [{ test_name: id, status: 'failed', error_text: 'boom' }],
    });
    const tmp = cwdWith([
      failing('old', '2026-01-01T00:00:00Z'),
      failing('new', '2026-06-01T00:00:00Z'),
    ]);
    try {
      const res = await invokeCanary(
        ['analyze', 'common-failures', '--json', '--since', '2026-03-01'],
        { cwd: tmp },
      );
      const rows = JSON.parse(res.stdout) as { test_name: string }[];
      expect(rows.map((r) => r.test_name)).toEqual(['new']);
    } finally {
      rmTmp(tmp);
    }
  });
});
