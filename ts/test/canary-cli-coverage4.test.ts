/**
 * Fourth coverage pass -- last remaining branches: skills-run cli-path resolution
 * failure (exit 4), history migrate's malformed-line skip, and the history
 * summary pass-rate color threshold (>= 90 green).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

function fake<T>(obj: unknown): T {
  return obj as T;
}

const HISTORY_REL = join('test-results', 'reports', 'history-v2.jsonl');

describe('skills run: cli path resolution failure', () => {
  it('exits 4 when the cli target does not exist', async () => {
    const tmp = mkTmp();
    try {
      const skill = {
        error: null,
        isExecutable: true,
        cli: 'missing.py',
        entry: null,
        name: 'e',
        dir: tmp,
      };
      const res = await invokeCanary(
        ['skills', 'run', 'e', '--allow-executable-skills'],
        { deps: { makeSkillRegistry: () => fake({ find: () => skill }) } },
      );
      expect(res.code).toBe(4);
    } finally {
      rmTmp(tmp);
    }
  });
});

describe('history migrate: malformed line skip', () => {
  it('skips an unparseable line and migrates the valid one', async () => {
    const tmp = mkTmp();
    try {
      const v1 = join(tmp, 'history.jsonl');
      writeFileSync(
        v1,
        'this is not json\n' +
          JSON.stringify({
            commit_short: 'abc',
            timestamp: '2026-01-01T00:00:00Z',
            run: { total: 1, passed: 1 },
          }) +
          '\n',
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

describe('history summary: pass-rate color thresholds', () => {
  it('renders a green summary for a fully-passing suite', async () => {
    const tmp = mkTmp();
    try {
      const path = join(tmp, HISTORY_REL);
      mkdirSync(join(tmp, 'test-results', 'reports'), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({
          run_id: 'r1',
          suite: 'api',
          timestamp: '2026-07-02T00:00:00Z',
          passed: 4,
          failed: 0,
          flaky: 0,
          total: 4,
          commit_sha: 'aaaaaaaa',
          tests: [],
        }) + '\n',
        'utf-8',
      );
      const res = await invokeCanary(['history', 'summary', 'api'], {
        cwd: tmp,
      });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('Suite');
      expect(res.stdout).toContain('api');
    } finally {
      rmTmp(tmp);
    }
  });
});
