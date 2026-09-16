/**
 * #604 Phase 1 — flake-window honesty disclosure (G2, G3, G4, H3).
 *
 * Every flake surface used to read as healthy over a window too thin to
 * measure: `canary ci-ready` returned `pass` with `0 flaky tests across 2
 * run(s)`, and `canary history flaky` / `canary analyze flaky` printed a green
 * `No tests above 10.0% flake rate...` line. A zero out of two runs is an
 * abstention, not a pass (ADR 0009), so these tests pin the four disclosures
 * the signed-off spec requires:
 *
 *   - SC1  a 1-9 run window makes ci-ready's flakiness check `warn`, never pass
 *   - SC2  a thin window drops the green line; `--json` says sufficient: false
 *   - SC3  every human flaky output states `read N runs (window W)`
 *   - SC4  a vitest-only window discloses that retry flakes are NOT MEASURABLE
 *          rather than reporting a structural zero as a measured one
 *   - SC5  a backend that cannot report its window renders UNKNOWN, and no
 *          clean verdict over it is a `pass`
 *
 * Spec: docs/changes/604-flakiness-detector/proposal.md
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CliExitError } from '../src/cli-common.js';
import { createHistoryCommand, type HistoryDeps } from '../src/history/cli.js';
import { createAnalyzeCommand, type AnalyzeDeps } from '../src/analysis/cli.js';
import {
  MIN_WINDOW_RUNS,
  measurabilityOf,
  type FlakyEnvelope,
} from '../src/util/flake-window.js';
import type { AsyncHistoryStore } from '../src/history/store.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

const HISTORY_REL = join('test-results', 'reports', 'history-v2.jsonl');

/**
 * Seed `runs` clean runs of one suite. `reporterFormat` is the run-level stamp
 * #604 adds so a read-time surface can tell a measured zero from a structural
 * one; `undefined` writes a legacy unstamped row.
 */
function seed(
  root: string,
  runs: number,
  reporterFormat?: string,
  flakyIn: number[] = [],
): void {
  const path = join(root, HISTORY_REL);
  mkdirSync(dirname(path), { recursive: true });
  const lines: string[] = [];
  for (let i = 0; i < runs; i++) {
    const flaky = flakyIn.includes(i);
    lines.push(
      JSON.stringify({
        schema_version: 2,
        run_id: `api-${i}`,
        suite: 'api',
        repo: 'acme/widgets',
        branch: 'main',
        commit_sha: `abc1234${i}`,
        timestamp: `2026-06-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        total: 1,
        passed: flaky ? 0 : 1,
        failed: 0,
        flaky: flaky ? 1 : 0,
        skipped: 0,
        ...(reporterFormat === undefined
          ? {}
          : { reporter_format: reporterFormat }),
        tests: [
          {
            test_name: 't1',
            test_file: 'tests/t1.spec.ts',
            status: flaky ? 'flaky' : 'passed',
          },
        ],
      }),
    );
  }
  writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
}

interface Check {
  name: string;
  verdict: string;
  reason: string;
}

async function flakinessCheck(root: string): Promise<Check> {
  const res = await invokeCanary(['ci-ready', '--root', root, '--json']);
  const report = JSON.parse(res.stdout) as { checks: Check[] };
  const check = report.checks.find((c) => c.name === 'flakiness');
  if (!check) throw new Error('no flakiness check in the report');
  return check;
}

function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Drive `history flaky` / `analyze flaky` against a store that implements
 * NEITHER `readAll` (raw records) — the shape of the remote Supabase backend,
 * which cannot report which runs a flake query read (G4 / SC5).
 */
async function runWithWindowlessStore(
  app: 'history' | 'analyze',
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const store: AsyncHistoryStore = {
    pushRun: async () => {},
    queryFlaky: async () => [],
    queryTimeline: async () => [],
    querySummary: async (suite) => ({
      suite,
      total_runs: 0,
      avg_pass_rate: 0,
    }),
    countRuns: async () => 42,
  };
  const deps = {
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    env: {},
    makeStore: () => store,
  };
  let code = 0;
  try {
    const command =
      app === 'history'
        ? createHistoryCommand(deps as Partial<HistoryDeps>)
        : createAnalyzeCommand(deps as Partial<AnalyzeDeps>);
    await command.parseAsync(args, { from: 'user' });
  } catch (e) {
    if (e instanceof CliExitError) code = e.code;
    else throw e;
  }
  return {
    code,
    stdout: strip(out.join('\n')),
    stderr: strip(err.join('\n')),
  };
}

describe('#604 SC1 — a thin window is not a passing ci-ready flakiness check', () => {
  it('warns, naming the denominator, on a 5-run window with no flakes', async () => {
    const root = mkTmp();
    try {
      seed(root, 5, 'playwright');
      const check = await flakinessCheck(root);
      // The whole point: this used to be `pass` with "0 flaky tests across 5
      // run(s)". Zero out of five is an abstention, not a clean suite.
      expect(check.verdict).toBe('warn');
      expect(check.verdict).not.toBe('pass');
      expect(check.reason).toContain('insufficient history');
      expect(check.reason).toContain(`5 of ${MIN_WINDOW_RUNS} runs`);
    } finally {
      rmTmp(root);
    }
  });

  it('passes once the window reaches the minimum', async () => {
    const root = mkTmp();
    try {
      seed(root, MIN_WINDOW_RUNS, 'playwright');
      const check = await flakinessCheck(root);
      expect(check.verdict).toBe('pass');
      expect(check.reason).not.toContain('insufficient history');
      expect(check.reason).toContain(`${MIN_WINDOW_RUNS} run(s)`);
    } finally {
      rmTmp(root);
    }
  });

  it('keeps skipping, not warning, on a genuinely empty store', async () => {
    const root = mkTmp();
    try {
      mkdirSync(join(root, 'test-results', 'reports'), { recursive: true });
      writeFileSync(join(root, HISTORY_REL), '', 'utf-8');
      const check = await flakinessCheck(root);
      expect(check.verdict).toBe('skip');
    } finally {
      rmTmp(root);
    }
  });

  it('still fails on a real finding, whatever the window size', async () => {
    const root = mkTmp();
    try {
      seed(root, 5, 'playwright', [2]); // 1 of 5 = 20%, over the 10% threshold
      const check = await flakinessCheck(root);
      expect(check.verdict).toBe('fail');
    } finally {
      rmTmp(root);
    }
  });
});

describe('#604 SC2/SC3 — history flaky discloses its window', () => {
  it('drops the green all-clear line on a thin window', async () => {
    const root = mkTmp();
    try {
      seed(root, 4, 'playwright');
      const res = await invokeCanary(['history', 'flaky'], { cwd: root });
      expect(res.code).toBe(0); // advisory
      expect(res.stdout).not.toContain('No tests above');
      expect(res.stdout).toContain('insufficient history');
      expect(res.stdout).toContain(`4 of ${MIN_WINDOW_RUNS} runs`);
    } finally {
      rmTmp(root);
    }
  });

  it('--json carries runs_read and sufficient: false (H3 envelope)', async () => {
    const root = mkTmp();
    try {
      seed(root, 4, 'playwright');
      const res = await invokeCanary(['history', 'flaky', '--json'], {
        cwd: root,
      });
      const env = JSON.parse(res.stdout) as FlakyEnvelope;
      expect(env.runs_read).toBe(4);
      expect(env.sufficient).toBe(false);
      expect(env.window_requested).toBe(30);
      expect(env.rows).toEqual([]);
      expect(env.disclosures.join(' ')).toContain('insufficient history');
    } finally {
      rmTmp(root);
    }
  });

  it('states "read N runs (window W)" on a sufficient window', async () => {
    const root = mkTmp();
    try {
      seed(root, 12, 'playwright');
      const res = await invokeCanary(['history', 'flaky'], { cwd: root });
      expect(res.stdout).toContain('read 12 runs (window 30)');
      expect(res.stdout).toContain('No tests above');
    } finally {
      rmTmp(root);
    }
  });

  it('--json is an envelope, not a bare array, on a sufficient window', async () => {
    const root = mkTmp();
    try {
      seed(root, 12, 'playwright');
      const res = await invokeCanary(['history', 'flaky', '--json'], {
        cwd: root,
      });
      const env = JSON.parse(res.stdout) as FlakyEnvelope;
      expect(Array.isArray(env)).toBe(false);
      expect(env.runs_read).toBe(12);
      expect(env.sufficient).toBe(true);
    } finally {
      rmTmp(root);
    }
  });

  it('counts runs READ in the window, not runs held in the store', async () => {
    const root = mkTmp();
    try {
      seed(root, 12, 'playwright');
      const res = await invokeCanary(
        ['history', 'flaky', '--window', '5', '--json'],
        { cwd: root },
      );
      const env = JSON.parse(res.stdout) as FlakyEnvelope;
      expect(env.window_requested).toBe(5);
      expect(env.runs_read).toBe(5);
      expect(env.sufficient).toBe(false);
    } finally {
      rmTmp(root);
    }
  });
});

describe('#604 SC2/SC3 — analyze flaky discloses its window', () => {
  it('drops the green all-clear line on a thin window', async () => {
    const root = mkTmp();
    try {
      seed(root, 4, 'playwright');
      const res = await invokeCanary(['analyze', 'flaky'], { cwd: root });
      expect(res.code).toBe(0);
      expect(res.stdout).not.toContain('No tests above');
      expect(res.stdout).toContain('insufficient history');
    } finally {
      rmTmp(root);
    }
  });

  it('states "read N runs (window W)" on a sufficient window', async () => {
    const root = mkTmp();
    try {
      seed(root, 12, 'playwright');
      const res = await invokeCanary(['analyze', 'flaky'], { cwd: root });
      expect(res.stdout).toContain('read 12 runs (window 30)');
    } finally {
      rmTmp(root);
    }
  });

  it('--json carries the envelope fields', async () => {
    const root = mkTmp();
    try {
      seed(root, 4, 'playwright');
      const res = await invokeCanary(['analyze', 'flaky', '--json'], {
        cwd: root,
      });
      const env = JSON.parse(res.stdout) as FlakyEnvelope;
      expect(env.runs_read).toBe(4);
      expect(env.sufficient).toBe(false);
    } finally {
      rmTmp(root);
    }
  });
});

describe('#604 SC4 — a vitest-only window is a STRUCTURAL zero', () => {
  it('history flaky names vitest rather than reporting a measured 0', async () => {
    const root = mkTmp();
    try {
      seed(root, 12, 'vitest');
      const res = await invokeCanary(['history', 'flaky'], { cwd: root });
      expect(res.stdout).toContain('not measurable');
      expect(res.stdout).toContain('vitest');
    } finally {
      rmTmp(root);
    }
  });

  it('--json reports flaky_measurable: "no"', async () => {
    const root = mkTmp();
    try {
      seed(root, 12, 'vitest');
      const res = await invokeCanary(['history', 'flaky', '--json'], {
        cwd: root,
      });
      const env = JSON.parse(res.stdout) as FlakyEnvelope;
      expect(env.flaky_measurable).toBe('no');
      expect(env.disclosures.join(' ')).toContain('not measurable');
    } finally {
      rmTmp(root);
    }
  });

  it('ci-ready still passes a sufficient window, but discloses the cause', async () => {
    const root = mkTmp();
    try {
      seed(root, 12, 'vitest');
      const check = await flakinessCheck(root);
      // Decision D7/the spec's verdict table: `pass`, plus the disclosure.
      expect(check.verdict).toBe('pass');
      expect(check.reason).toContain('not measurable');
      expect(check.reason).toContain('vitest');
    } finally {
      rmTmp(root);
    }
  });

  it('a playwright window is measurable, so the zero stands unqualified', async () => {
    const root = mkTmp();
    try {
      seed(root, 12, 'playwright');
      const res = await invokeCanary(['history', 'flaky', '--json'], {
        cwd: root,
      });
      const env = JSON.parse(res.stdout) as FlakyEnvelope;
      expect(env.flaky_measurable).toBe('yes');
      expect(env.disclosures.join(' ')).not.toContain('not measurable');
    } finally {
      rmTmp(root);
    }
  });

  it('a legacy unstamped window is UNKNOWN, never assumed measurable', async () => {
    const root = mkTmp();
    try {
      seed(root, 12);
      const res = await invokeCanary(['history', 'flaky', '--json'], {
        cwd: root,
      });
      const env = JSON.parse(res.stdout) as FlakyEnvelope;
      expect(env.flaky_measurable).toBe('unknown');
      expect(env.disclosures.join(' ')).toContain('unknown');
    } finally {
      rmTmp(root);
    }
  });
});

describe('#604 SC4 — measurability precedence', () => {
  it('one flaky-capable reader in the window makes it measurable', () => {
    expect(
      measurabilityOf([
        { reporter_format: 'vitest' },
        { reporter_format: 'playwright' },
      ]),
    ).toBe('yes');
    expect(measurabilityOf([{ reporter_format: 'junit' }])).toBe('yes');
  });

  it('an unstamped run leaves the window UNKNOWN, not measurable', () => {
    expect(measurabilityOf([{ reporter_format: 'vitest' }, {}])).toBe(
      'unknown',
    );
    expect(measurabilityOf([])).toBe('unknown');
  });

  it('an all-vitest window is the one honest "no"', () => {
    expect(
      measurabilityOf([
        { reporter_format: 'vitest' },
        { reporter_format: 'vitest' },
      ]),
    ).toBe('no');
  });
});

describe('#604 SC5 — a backend with no window renders UNKNOWN, never a pass', () => {
  it('history flaky discloses UNKNOWN instead of the green line', async () => {
    const res = await runWithWindowlessStore('history', ['flaky']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('UNKNOWN');
    expect(res.stdout).not.toContain('No tests above');
  });

  it('history flaky --json reports runs_read: null, sufficient: null', async () => {
    const res = await runWithWindowlessStore('history', ['flaky', '--json']);
    const env = JSON.parse(res.stdout) as FlakyEnvelope;
    expect(env.runs_read).toBeNull();
    expect(env.sufficient).toBeNull();
    expect(env.flaky_measurable).toBe('unknown');
    expect(env.disclosures.join(' ')).toContain('UNKNOWN');
  });

  it('analyze flaky discloses UNKNOWN instead of the green line', async () => {
    const res = await runWithWindowlessStore('analyze', ['flaky']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('UNKNOWN');
    expect(res.stdout).not.toContain('No tests above');
  });
});
