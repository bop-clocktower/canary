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
  it('flaky --json emits a JSON array on an empty store', async () => {
    const tmp = mkTmp();
    try {
      const res = await invokeCanary(['history', 'flaky', '--json'], {
        cwd: tmp,
      });
      expect(res.code).toBe(0);
      expect(Array.isArray(JSON.parse(res.stdout))).toBe(true);
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
