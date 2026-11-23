/**
 * #1298: `history migrate` derived an untimestamped v1 entry's run_id from the
 * CURRENT second, so two such entries for one commit collided, the store's
 * idempotent `pushRun` dropped the second, and the command still printed
 * `Migrated 2 runs`. The ids must be unique, deterministic (the same file
 * migrates to the same ids on every run), and the count must match the writes.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

const HISTORY_REL = join('test-results', 'reports', 'history-v2.jsonl');

function writeV1(dir: string, entries: object[]): string {
  const v1 = join(dir, 'history.jsonl');
  writeFileSync(v1, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return v1;
}

function storedRunIds(dir: string): string[] {
  return readFileSync(join(dir, HISTORY_REL), 'utf-8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => (JSON.parse(l) as { run_id: string }).run_id);
}

const migrate = (v1: string, cwd: string) =>
  invokeCanary(['history', 'migrate', v1, '--suite', 'api', '--repo', 'o/r'], {
    cwd,
  });

describe('history migrate run ids (#1298)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes one run per v1 entry when entries carry no timestamp', async () => {
    const tmp = mkTmp();
    try {
      const v1 = writeV1(tmp, [
        { commit_short: 'aaa', run: { total: 5, passed: 5 } },
        { commit_short: 'aaa', run: { total: 9, passed: 1, failed: 8 } },
      ]);
      const res = await migrate(v1, tmp);
      expect(storedRunIds(tmp)).toHaveLength(2);
      expect(res.stdout).toContain('Migrated 2 runs, skipped 0');
    } finally {
      rmTmp(tmp);
    }
  });

  it('derives the same ids on every run, so a re-migration adds nothing', async () => {
    const tmp = mkTmp();
    try {
      const v1 = writeV1(tmp, [
        { commit_short: 'aaa', run: { total: 5, passed: 5 } },
        { commit_short: 'aaa', run: { total: 9, passed: 1, failed: 8 } },
      ]);
      // Two runs a minute apart: an id taken from the clock would differ.
      vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 0, 1, 0, 0) });
      await migrate(v1, tmp);
      const first = storedRunIds(tmp);
      vi.setSystemTime(Date.UTC(2026, 0, 1, 0, 1));
      const again = await migrate(v1, tmp);
      expect(storedRunIds(tmp)).toEqual(first);
      // Nothing was written the second time, so nothing is reported migrated.
      expect(again.stdout).not.toContain('Migrated');
      expect(again.stdout).toContain('skipped 2');
    } finally {
      rmTmp(tmp);
    }
  });

  it('counts an entry whose id repeats an earlier one in the file as skipped', async () => {
    const tmp = mkTmp();
    try {
      const entry = {
        commit_short: 'bbb',
        timestamp: '2026-01-01T00:00:00Z',
        run: { total: 1, passed: 1 },
      };
      const v1 = writeV1(tmp, [entry, entry]);
      const res = await migrate(v1, tmp);
      expect(storedRunIds(tmp)).toHaveLength(1);
      expect(res.stdout).toContain('Migrated 1 runs, skipped 1');
    } finally {
      rmTmp(tmp);
    }
  });

  it('keys an untimestamped entry on its content, not its line', async () => {
    const a = { commit_short: 'aaa', run: { total: 5, passed: 5 } };
    const b = { commit_short: 'aaa', run: { total: 9, passed: 1, failed: 8 } };
    const ids: string[][] = [];
    for (const order of [
      [a, b],
      [{ commit_short: 'zzz', run: {} }, b, a],
    ]) {
      const tmp = mkTmp();
      try {
        await migrate(writeV1(tmp, order), tmp);
        ids.push(storedRunIds(tmp).filter((id) => id.startsWith('api-aaa')));
      } finally {
        rmTmp(tmp);
      }
    }
    expect(new Set(ids[1])).toEqual(new Set(ids[0]));
  });

  it('keeps an epoch-zero timestamp as a timestamp', async () => {
    const tmp = mkTmp();
    try {
      const v1 = writeV1(tmp, [
        {
          commit_short: 'ccc',
          timestamp: '1970-01-01T00:00:00Z',
          run: { total: 1, passed: 1 },
        },
      ]);
      await migrate(v1, tmp);
      expect(storedRunIds(tmp)).toEqual(['api-ccc-0']);
    } finally {
      rmTmp(tmp);
    }
  });
});
