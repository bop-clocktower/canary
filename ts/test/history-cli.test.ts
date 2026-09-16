/**
 * CLI coverage for `canary history` (the sub-app has no Python CLI test to port,
 * so these mirror its command behavior). Drives the sub-app through the main CLI
 * against a temp cwd so the default local store path resolves.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

const HISTORY_REL = join('test-results', 'reports', 'history-v2.jsonl');

describe('canary history', () => {
  // #604 H3: `--json` is an envelope, not a bare array, so the denominator
  // travels with the rows. An empty store abstains INSIDE the envelope.
  it('flaky --json emits the envelope on an empty store', async () => {
    const tmp = mkTmp();
    try {
      const res = await invokeCanary(['history', 'flaky', '--json'], {
        cwd: tmp,
      });
      expect(res.code).toBe(0);
      const env = JSON.parse(res.stdout) as {
        runs_read: number;
        sufficient: boolean;
        rows: unknown[];
      };
      expect(Array.isArray(env.rows)).toBe(true);
      expect(env.rows).toEqual([]);
      expect(env.runs_read).toBe(0);
      expect(env.sufficient).toBe(false);
    } finally {
      rmTmp(tmp);
    }
  });

  it('summary --json emits a JSON object', async () => {
    const tmp = mkTmp();
    try {
      const res = await invokeCanary(
        ['history', 'summary', 'checkout', '--json'],
        {
          cwd: tmp,
        },
      );
      expect(res.code).toBe(0);
      const obj = JSON.parse(res.stdout) as Record<string, unknown>;
      expect(obj).toHaveProperty('suite');
    } finally {
      rmTmp(tmp);
    }
  });

  it('push exits 1 when the history file is missing', async () => {
    const tmp = mkTmp();
    try {
      const res = await invokeCanary(
        ['history', 'push', join(tmp, 'nope.jsonl')],
        { cwd: tmp },
      );
      expect(res.code).toBe(1);
      expect(res.stdout).toContain('Not found:');
    } finally {
      rmTmp(tmp);
    }
  });

  it('push --dry-run reports the latest run without pushing', async () => {
    const tmp = mkTmp();
    try {
      const path = join(tmp, HISTORY_REL);
      mkdirSync(dirname(path), { recursive: true });
      const record = {
        run_id: 'run-xyz',
        suite: 'api',
        repo: 'a/b',
        branch: 'main',
        commit_sha: 'deadbeef',
        timestamp: '2026-07-02T00:00:00Z',
        total: 1,
        passed: 1,
        failed: 0,
        flaky: 0,
        skipped: 0,
        tests: [
          {
            run_id: 'run-xyz',
            suite: 'api',
            repo: 'a/b',
            test_name: 't1',
            test_file: 'f',
            status: 'passed',
          },
        ],
      };
      writeFileSync(path, JSON.stringify(record) + '\n', 'utf-8');
      const res = await invokeCanary(['history', 'push', path, '--dry-run'], {
        cwd: tmp,
      });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('dry-run:');
      expect(res.stdout).toContain('run-xyz');
    } finally {
      rmTmp(tmp);
    }
  });

  it('migrate --dry-run reports a migrated count', async () => {
    const tmp = mkTmp();
    try {
      const v1 = join(tmp, 'history.jsonl');
      writeFileSync(
        v1,
        JSON.stringify({
          commit_short: 'abc1234',
          timestamp: '2026-01-01T00:00:00Z',
          branch: 'main',
          run: { total: 3, passed: 3, failed: 0, flaky: 0, skipped: 0 },
        }) + '\n',
        'utf-8',
      );
      const res = await invokeCanary(
        [
          'history',
          'migrate',
          v1,
          '--suite',
          'api',
          '--repo',
          'a/b',
          '--dry-run',
        ],
        { cwd: tmp },
      );
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('Migrated 1 runs');
    } finally {
      rmTmp(tmp);
    }
  });
});

// bug-fleet (history): helpers for the window/ordering repros below.
function writeRuns(tmp: string, runs: Record<string, unknown>[]): void {
  const path = join(tmp, HISTORY_REL);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, runs.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function run(id: string, timestamp: string, passed: number, failed: number) {
  return {
    schema_version: 2,
    run_id: id,
    suite: 'api',
    branch: 'main',
    commit_sha: 'abc',
    timestamp,
    total: passed + failed,
    passed,
    failed,
    flaky: 0,
    skipped: 0,
    tests: [{ test_name: 't', status: failed > 0 ? 'failed' : 'passed' }],
  };
}

describe('canary history run-count flags', () => {
  // A window of 0 / a non-number used to read EVERY run (`slice(-0)`,
  // `slice(NaN)`) -- the widest window, reported under the narrowest flag.
  it.each([
    [['history', 'flaky', '--window', '0', '--json']],
    [['history', 'flaky', '--window', 'seven', '--json']],
    [['history', 'summary', 'api', '--runs', '0', '--json']],
    [['history', 'summary', 'api', '--runs', 'seven', '--json']],
  ])('rejects a run count below 1: %j', async (args) => {
    const tmp = mkTmp();
    try {
      writeRuns(tmp, [
        run('r1', '2026-01-01T00:00:00Z', 1, 0),
        run('r2', '2026-01-02T00:00:00Z', 1, 0),
        run('r3', '2026-01-03T00:00:00Z', 1, 0),
      ]);
      const res = await invokeCanary(args, { cwd: tmp });
      expect(res.code).not.toBe(0);
    } finally {
      rmTmp(tmp);
    }
  });
});
