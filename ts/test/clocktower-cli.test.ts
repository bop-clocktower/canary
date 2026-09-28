/**
 * CLI coverage for `canary history gaps` (#610).
 *
 * The exit contract is the CLI-wide one (core/gate-result.ts): 0 every measured
 * consumer fed, 1 any dark or partial, 3 abstained. A missing store and an
 * empty store are BOTH abstentions, but with different reasons -- the reader
 * returns [] for both, so only the command's own existence check keeps a
 * typo'd path from reading as "the store is empty".
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONSUMERS } from '../src/analysis/clocktower/consumers.js';
import { ENGINE_COMMANDS } from '../src/commands/engine/cli.js';
import type { MainDeps } from '../src/main-deps.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

const HISTORY_REL = join('test-results', 'reports', 'history-v2.jsonl');

type Row = Record<string, unknown>;

/** A run carrying every field every consumer reads. */
function fedRun(i: number, testExtra: Row = {}): Row {
  return {
    run_id: `run-${i}`,
    suite: 'web',
    branch: 'main',
    commit_sha: 'c'.repeat(40),
    timestamp: `2026-09-21T00:0${i}:00Z`,
    duration_ms: 1000,
    reporter_format: 'playwright',
    replay: { seed: null },
    order: { ttff_ordered_ms_estimate: 1 },
    tests: [
      {
        test_name: 'checks out',
        status: 'failed',
        area: 'checkout',
        failure_category: 'assertion',
        error_text: 'expected 200, got 500',
        test_file: 'tests/checkout.spec.ts',
        duration_ms: 50,
        start_index: 0,
        ...testExtra,
      },
    ],
  };
}

function seed(dir: string, rows: Row[] | string): string {
  const path = join(dir, HISTORY_REL);
  mkdirSync(dirname(path), { recursive: true });
  const body =
    typeof rows === 'string'
      ? rows
      : rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(path, body, 'utf-8');
  return path;
}

let tmp: string;
beforeEach(() => {
  tmp = mkTmp();
});
afterEach(() => {
  rmTmp(tmp);
});

function gaps(args: string[] = [], env: Record<string, string> = {}) {
  return invokeCanary(['history', 'gaps', ...args], { cwd: tmp, env });
}

describe('canary history gaps', () => {
  it('exits 3 and says not found when the store path does not exist', async () => {
    const res = await gaps(['--path', 'nope/history.jsonl']);
    expect(res.code).toBe(3);
    expect(res.stdout).toContain('store not found: nope/history.jsonl');
    expect(res.stdout).toContain('Abstained');
    expect(res.stdout).not.toContain('passed');
  });

  it('exits 3 and says the store is empty for a zero-run store', async () => {
    seed(tmp, '\n');
    const res = await gaps();
    expect(res.code).toBe(3);
    expect(res.stdout).toContain(`store is empty: ${HISTORY_REL} (0 runs)`);
    expect(res.stdout).toContain('dark by abstention: screech-range,');
    expect(res.stdout).not.toContain('passed');
  });

  it('exits 0 when every measured consumer is fed', async () => {
    seed(tmp, [fedRun(1), fedRun(2)]);
    const res = await gaps();
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('2 run(s), 2 test(s)');
    expect(res.stdout).toContain('All 9 run consumer check(s) passed');
  });

  it('exits 1 when any consumer is dark or partial', async () => {
    seed(tmp, [fedRun(1, { area: null }), fedRun(2, { area: null })]);
    const res = await gaps();
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('flaky-area: dark');
    expect(res.stdout).toContain('area: 0/2 tests');
    // The owning-area half of screech goes dark with it (C1).
    expect(res.stdout).toContain('screech-cluster: dark');
    expect(res.stdout).toContain('area: 0/2 failed tests');
    expect(res.stdout).toContain('2 finding(s) across 9 checked');
  });

  it('reports partial coverage with its denominator', async () => {
    seed(tmp, [fedRun(1), fedRun(2, { area: '' })]);
    const res = await gaps();
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('flaky-area: partial');
    expect(res.stdout).toContain('area: 1/2 tests');
  });

  it('names unmeasured consumers as skipped in the summary line', async () => {
    seed(tmp, [fedRun(1, { status: 'passed' })]);
    const res = await gaps();
    expect(res.stdout).toContain('failure-categories: unmeasured');
    expect(res.stdout).toContain(
      '3 skipped: screech-cluster, failure-categories, rewind [no applicable rows]',
    );
    expect(res.stdout).toContain('All 6 run consumer check(s) passed');
    expect(res.code).toBe(0);
  });

  it('names the remote store as skipped when CANARY_HISTORY_DB_URL is set', async () => {
    seed(tmp, [fedRun(1)]);
    const res = await gaps([], { CANARY_HISTORY_DB_URL: 'postgres://x' });
    expect(res.stdout).toContain('remote store [local NDJSON only]');
  });

  it('skips, rather than fails on, an opt-in consumer nobody opted into', async () => {
    const { order: _order, ...noPlan } = fedRun(1);
    seed(tmp, [noPlan]);
    const res = await gaps();
    expect(res.stdout).toContain(
      'order-ttff: dark (fed only by `history record --order-plan`)',
    );
    expect(res.stdout).toContain(
      'order-ttff [opt-in: not recorded with history record --order-plan]',
    );
    expect(res.stdout).toContain('All 8 run consumer check(s) passed');
    expect(res.code).toBe(0);
  });

  it('--json lists every skipped entry, including the remote store', async () => {
    seed(tmp, [fedRun(1, { status: 'passed' })]);
    const res = await gaps(['--json'], {
      CANARY_HISTORY_DB_URL: 'postgres://x',
    });
    expect(res.code).toBe(0);
    const body = JSON.parse(res.stdout) as { skipped: unknown[] };
    expect(body.skipped).toEqual([
      { name: 'screech-cluster', reason: 'no applicable rows' },
      { name: 'failure-categories', reason: 'no applicable rows' },
      { name: 'rewind', reason: 'no applicable rows' },
      { name: 'remote store', reason: 'local NDJSON only' },
    ]);
  });

  it('--json emits path, abstained, runs, tests, consumers, skipped and exitCode', async () => {
    seed(tmp, [fedRun(1, { area: null })]);
    const res = await gaps(['--json']);
    expect(res.code).toBe(1);
    const body = JSON.parse(res.stdout) as {
      path: string;
      abstained: boolean;
      runs: number;
      tests: number;
      exitCode: number;
      consumers: { id: string; status: string }[];
    };
    expect(body).toMatchObject({
      path: HISTORY_REL,
      abstained: false,
      runs: 1,
      tests: 1,
      skipped: [],
      exitCode: 1,
    });
    expect(body.consumers.find((c) => c.id === 'flaky-area')!.status).toBe(
      'dark',
    );
  });

  it('--json abstention carries the reason, what went dark and exitCode 3', async () => {
    const res = await gaps(['--json', '--path', 'gone.jsonl'], {
      CANARY_HISTORY_DB_URL: 'postgres://x',
    });
    expect(res.code).toBe(3);
    expect(JSON.parse(res.stdout)).toMatchObject({
      abstained: true,
      reason: 'store not found: gone.jsonl',
      runs: 0,
      darkByAbstention: CONSUMERS.map((c) => c.id),
      skipped: [{ name: 'remote store', reason: 'local NDJSON only' }],
      exitCode: 3,
    });
  });

  it('exits 1 with the reader error on a malformed store', async () => {
    seed(tmp, '{not json\n');
    const res = await gaps();
    expect(res.code).toBe(1);
    expect(res.stderr).toContain(`Cannot read ${HISTORY_REL}`);
    expect(res.stdout).not.toContain('Abstained');
  });

  it('rejects an unknown flag with usage exit 2', async () => {
    const res = await gaps(['--nope']);
    expect(res.code).toBe(2);
  });

  it('is mounted on canary history with its flags in the help text', () => {
    const history = ENGINE_COMMANDS[0]!({
      out: () => {},
      err: () => {},
    } as unknown as MainDeps);
    expect(history.name()).toBe('history');
    const help = history.helpInformation().replace(/\s+/g, ' ');
    expect(help).toMatch(/gaps \[options\] Report which history consumers/);
    const sub = history.commands.find((c) => c.name() === 'gaps')!;
    const subHelp = sub.helpInformation().replace(/\s+/g, ' ');
    for (const flag of ['--path <store>', '--json']) {
      expect(subHelp).toContain(flag);
    }
  });
});
