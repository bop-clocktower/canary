/**
 * `history flaky --min-rate` must reject a value that is not a number.
 *
 * A bare `parseFloat` turned `--min-rate abc` into NaN; every
 * `flake_rate_pct >= NaN` comparison is false, so a store full of flaky tests
 * printed zero rows and exited 0 -- a false clean, under the flag meant to
 * narrow the report. `--window` / `--runs` already refuse a bad value.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

const HISTORY_REL = join('test-results', 'reports', 'history-v2.jsonl');

function flakyRun(i: number): Record<string, unknown> {
  return {
    schema_version: 2,
    run_id: `r${i}`,
    suite: 'api',
    branch: 'main',
    commit_sha: 'abc',
    timestamp: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    reporter_format: 'playwright',
    total: 1,
    passed: 0,
    failed: 0,
    flaky: 1,
    skipped: 0,
    tests: [{ test_name: 't', status: 'flaky' }],
  };
}

describe('history flaky --min-rate', () => {
  it.each([['abc'], ['high'], ['']])(
    'refuses a non-numeric value (%j) instead of reading it as NaN',
    async (value) => {
      const tmp = mkTmp();
      try {
        const path = join(tmp, HISTORY_REL);
        mkdirSync(dirname(path), { recursive: true });
        const runs = Array.from({ length: 12 }, (_, i) => flakyRun(i));
        writeFileSync(
          path,
          runs.map((r) => JSON.stringify(r)).join('\n') + '\n',
        );
        const res = await invokeCanary(
          ['history', 'flaky', '--min-rate', value],
          { cwd: tmp },
        );
        expect(res.code).not.toBe(0);
      } finally {
        rmTmp(tmp);
      }
    },
  );
});
