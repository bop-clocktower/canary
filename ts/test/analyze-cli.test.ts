/**
 * CliRunner-parity tests for `canary analyze` -- port of
 * `tests/unit/test_analysis_cli.py`. Drives each subcommand against a seeded
 * local history store (a temp cwd so the default store path resolves) and
 * asserts the human-readable and --json paths plus the empty-store degradation.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

const HISTORY_REL = join('test-results', 'reports', 'history-v2.jsonl');

function seededCwd(seed = true): string {
  const tmp = mkTmp();
  if (seed) {
    const path = join(tmp, HISTORY_REL);
    mkdirSync(dirname(path), { recursive: true });
    const record = {
      run_id: 'r1',
      suite: 'checkout',
      timestamp: '2026-07-02T00:00:00Z',
      passed: 1,
      failed: 1,
      flaky: 1,
      total: 3,
      commit_sha: 'aaa',
      tests: [
        { test_name: 'test_ok', status: 'passed' },
        {
          test_name: 'test_pay',
          status: 'failed',
          failure_category: 'assertion',
          error_text: 'AssertionError: boom',
        },
        {
          test_name: 'test_flaky',
          status: 'flaky',
          failure_category: 'timeout',
          error_text: 'TimeoutError',
        },
      ],
    };
    writeFileSync(path, JSON.stringify(record) + '\n', 'utf-8');
  }
  return tmp;
}

describe('canary analyze', () => {
  it('flaky --json emits a valid JSON array', async () => {
    const tmp = seededCwd();
    try {
      const res = await invokeCanary(
        ['analyze', 'flaky', '--json', '--min-rate', '0'],
        { cwd: tmp },
      );
      expect(res.code).toBe(0);
      expect(() => JSON.parse(res.stdout)).not.toThrow();
    } finally {
      rmTmp(tmp);
    }
  });

  it('flaky human output succeeds', async () => {
    const tmp = seededCwd();
    try {
      const res = await invokeCanary(['analyze', 'flaky', '--min-rate', '0'], {
        cwd: tmp,
      });
      expect(res.code).toBe(0);
    } finally {
      rmTmp(tmp);
    }
  });

  it('spikes --json emits valid JSON', async () => {
    const tmp = seededCwd();
    try {
      const res = await invokeCanary(['analyze', 'spikes', '--json'], {
        cwd: tmp,
      });
      expect(res.code).toBe(0);
      expect(() => JSON.parse(res.stdout)).not.toThrow();
    } finally {
      rmTmp(tmp);
    }
  });

  it('common-failures --json lists failures', async () => {
    const tmp = seededCwd();
    try {
      const res = await invokeCanary(['analyze', 'common-failures', '--json'], {
        cwd: tmp,
      });
      expect(res.code).toBe(0);
      const rows = JSON.parse(res.stdout) as { test_name: string }[];
      expect(rows.some((r) => r.test_name === 'test_pay')).toBe(true);
    } finally {
      rmTmp(tmp);
    }
  });

  it('regression-candidates --json emits valid JSON', async () => {
    const tmp = seededCwd();
    try {
      const res = await invokeCanary(
        ['analyze', 'regression-candidates', '--json'],
        { cwd: tmp },
      );
      expect(res.code).toBe(0);
      expect(() => JSON.parse(res.stdout)).not.toThrow();
    } finally {
      rmTmp(tmp);
    }
  });

  it('digest writes artifacts and JSON counts', async () => {
    const tmp = seededCwd();
    try {
      const res = await invokeCanary(
        ['analyze', 'digest', '--json', '--output', 'out-dir'],
        { cwd: tmp },
      );
      expect(res.code).toBe(0);
      const payload = JSON.parse(res.stdout) as Record<string, unknown>;
      expect(payload).toHaveProperty('flaky_count');
      expect(existsSync(join(tmp, 'out-dir', 'digest.md'))).toBe(true);
    } finally {
      rmTmp(tmp);
    }
  });

  it('digest on an empty store does not crash', async () => {
    const tmp = seededCwd(false);
    try {
      const res = await invokeCanary(
        ['analyze', 'digest', '--output', 'out-dir'],
        { cwd: tmp },
      );
      expect(res.code).toBe(0);
    } finally {
      rmTmp(tmp);
    }
  });
});
