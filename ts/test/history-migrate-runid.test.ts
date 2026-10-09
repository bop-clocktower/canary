/**
 * `history migrate` must not lose a run whose v1 entry has no timestamp.
 *
 * A missing timestamp fell back to the CURRENT second for the run id, so two
 * untimestamped entries for one commit minted the same `run_id`; the store's
 * idempotent `pushRun` silently dropped the second, while the command still
 * printed `Migrated 2 runs`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

const HISTORY_REL = join('test-results', 'reports', 'history-v2.jsonl');

describe('history migrate run ids', () => {
  it('writes one run per v1 entry when entries carry no timestamp', async () => {
    const tmp = mkTmp();
    try {
      const v1 = join(tmp, 'history.jsonl');
      writeFileSync(
        v1,
        [
          { commit_short: 'aaa', run: { total: 5, passed: 5 } },
          { commit_short: 'aaa', run: { total: 9, passed: 1, failed: 8 } },
        ]
          .map((e) => JSON.stringify(e))
          .join('\n') + '\n',
      );
      await invokeCanary(
        ['history', 'migrate', v1, '--suite', 'api', '--repo', 'o/r'],
        { cwd: tmp },
      );
      const lines = readFileSync(join(tmp, HISTORY_REL), 'utf-8')
        .split('\n')
        .filter((l) => l.trim() !== '');
      expect(lines).toHaveLength(2);
    } finally {
      rmTmp(tmp);
    }
  });
});
