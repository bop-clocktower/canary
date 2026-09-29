/**
 * The #1125 seam: `record` applies an injected enricher and prints its notes.
 * Without one, rows are stored exactly as the reader built them, so `history`
 * keeps working without `analysis`.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CliExitError } from '../src/cli-common.js';
import { createHistoryCommand } from '../src/history/cli.js';
// The seam under test is declared in cli-deps.ts (#1125).
import type { HistoryDeps } from '../src/history/cli-deps.js';
import type { RunInput, TestResultInput } from '../src/history/schema.js';
import type { AsyncHistoryStore } from '../src/history/store.js';
import { mkTmp, rmTmp } from './canary-cli-testkit.js';

const ENV = { GITHUB_REPOSITORY: 'acme/widgets', GITHUB_SHA: 'a'.repeat(40) };

let tmp: string;
let src: string;
beforeEach(() => {
  tmp = mkTmp();
  src = join(tmp, 'vitest.json');
  const assertion = {
    fullName: 't',
    title: 't',
    status: 'failed',
    duration: 5,
    failureMessages: ['boom'],
  };
  writeFileSync(
    src,
    JSON.stringify({
      startTime: 1_754_000_000_000,
      testResults: [
        { name: 'test/checkout.test.ts', assertionResults: [assertion] },
      ],
    }),
    'utf-8',
  );
});
afterEach(() => {
  rmTmp(tmp);
});

async function record(extra: Partial<HistoryDeps>) {
  const pushed: TestResultInput[][] = [];
  const runs: RunInput[] = [];
  const store: AsyncHistoryStore = {
    pushRun: async (run, results) => {
      runs.push(run);
      pushed.push(results);
    },
    countRuns: async () => runs.length,
    queryFlaky: async () => [],
    queryTimeline: async () => [],
    querySummary: async (suite) => ({
      suite,
      total_runs: 0,
      avg_pass_rate: 0,
    }),
  };
  const err: string[] = [];
  let code = 0;
  try {
    await createHistoryCommand({
      out: () => {},
      err: (s) => err.push(s),
      env: ENV as NodeJS.ProcessEnv,
      makeStore: () => store,
      git: () => null,
      cwd: () => tmp,
      ...extra,
    }).parseAsync(['record', src, '--suite', 'api'], { from: 'user' });
  } catch (e) {
    if (!(e instanceof CliExitError)) throw e;
    code = e.code;
  }
  return { code, rows: pushed[0] ?? [], stderr: err.join('\n') };
}

describe('history record enrichResults seam (#1125)', () => {
  it('stores the enricher output and prints its notes', async () => {
    const seen: string[] = [];
    const res = await record({
      enrichResults: (results, cwd) => {
        seen.push(cwd);
        return {
          results: results.map((r) => ({ ...r, area: 'src/checkout.ts' })),
          notes: ['enricher says hi'],
        };
      },
    });
    expect(res.code).toBe(0);
    expect(seen).toEqual([tmp]);
    expect(res.rows.map((r) => r.area)).toEqual(['src/checkout.ts']);
    expect(res.stderr).toContain('note: enricher says hi');
  });

  it('stores rows unenriched and prints no note without an enricher', async () => {
    const res = await record({});
    expect(res.code).toBe(0);
    expect(res.rows).toHaveLength(1);
    expect('area' in res.rows[0]!).toBe(false);
    expect(res.stderr).not.toContain('area not recorded');
  });
});
