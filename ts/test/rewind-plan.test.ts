/**
 * `canary rewind` pure half (#461 PR 2): locating the failure, the fidelity
 * table, repeat classification and nearest green. Proposal criteria 3, 5, 6,
 * 7 and 8, plus the lookup half of 4.
 */

import { describe, expect, it } from 'vitest';

import {
  DIMENSIONS,
  classifyRepeats,
  fidelityRows,
  locateFailure,
  nearestGreen,
} from '../src/analysis/rewind/plan.js';
import type { RunRecord } from '../src/history/record.js';

const HOST = { node: 'v22.23.2', os: 'linux', arch: 'x64' };

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: 'r1',
    suite: 's',
    commit_sha: 'a'.repeat(40),
    reporter_format: 'vitest',
    schema_version: 3,
    replay: {
      seed: '42',
      seed_source: 'flag',
      runner: { name: 'vitest', version: null },
      node: 'v22.23.2',
      os: 'linux',
      arch: 'x64',
      ci: null,
      commit_source: 'flag',
    },
    tests: [
      {
        test_name: 't',
        status: 'failed',
        test_file: 'x.test.ts',
        start_index: 1,
      },
    ],
    ...over,
  };
}

describe('locateFailure', () => {
  it('finds the failed test in the named run', () => {
    const found = locateFailure([run()], 'r1', 't');
    expect(found).toMatchObject({ ok: true, test: { test_name: 't' } });
  });

  it.each([
    ['an absent run', [run()], 'nope', 't', /run 'nope' is not in/],
    ['an absent test', [run()], 'r1', 'other', /no test named 'other'/],
    [
      'a test that did not fail',
      [
        run({
          tests: [{ test_name: 't', status: 'passed', test_file: 'x' }],
        }),
      ],
      'r1',
      't',
      /did not fail/,
    ],
    [
      'a local commit',
      [run({ commit_sha: 'local' })],
      'r1',
      't',
      /commit 'local'/,
    ],
    [
      'an unsupported runner',
      [run({ reporter_format: 'junit' })],
      'r1',
      't',
      /no replay command for 'junit'/,
    ],
  ])('abstains on %s', (_label, runs, runId, name, reason) => {
    const found = locateFailure(runs, runId, name);
    expect(found.ok).toBe(false);
    if (!found.ok) expect(found.reason).toMatch(reason);
  });

  it('accepts a flaky test, which failed at least once', () => {
    const flaky = run({
      tests: [{ test_name: 't', status: 'flaky', test_file: 'x' }],
    });
    expect(locateFailure([flaky], 'r1', 't').ok).toBe(true);
  });
});

describe('fidelityRows', () => {
  const opts = {
    commitRestored: true,
    seedApplied: true,
    withPredecessors: false,
    host: HOST,
    installFailed: null,
  };

  it('criterion 5: one row per dimension, each with exactly one status', () => {
    const rows = fidelityRows(run(), run().tests![0]!, opts);
    expect(rows.map((r) => r.dimension)).toEqual([...DIMENSIONS]);
    for (const r of rows) {
      expect(['restored', 'not-restored', 'not-recorded']).toContain(r.status);
    }
  });

  it('criterion 5: network, database and wall-clock are always not-restored', () => {
    const rows = fidelityRows(run(), run().tests![0]!, opts);
    for (const d of ['network', 'database', 'wall-clock']) {
      expect(rows.find((r) => r.dimension === d)!.status).toBe('not-restored');
    }
  });

  it('criterion 3: a pre-v3 record lists seed, order and environment as not-recorded', () => {
    const legacy = run({ schema_version: 2 });
    delete legacy.replay;
    const test = { test_name: 't', status: 'failed', test_file: 'x' };
    const rows = fidelityRows(legacy, test, { ...opts, seedApplied: false });
    const status = (d: string): string =>
      rows.find((r) => r.dimension === d)!.status;
    expect(status('seed')).toBe('not-recorded');
    expect(status('order')).toBe('not-recorded');
    expect(status('environment')).toBe('not-recorded');
    expect(status('commit')).toBe('restored');
  });

  it('criterion 6: a differing fingerprint names each differing key and is never restored', () => {
    const rows = fidelityRows(run(), run().tests![0]!, {
      ...opts,
      host: { node: 'v24.0.0', os: 'darwin', arch: 'x64' },
    });
    const env = rows.find((r) => r.dimension === 'environment')!;
    expect(env.status).toBe('not-restored');
    expect(env.reason).toContain('node');
    expect(env.reason).toContain('os');
    expect(env.reason).not.toContain('arch');
  });

  it('an identical fingerprint restores the environment', () => {
    const rows = fidelityRows(run(), run().tests![0]!, opts);
    expect(rows.find((r) => r.dimension === 'environment')!.status).toBe(
      'restored',
    );
  });

  it('an install failure makes the environment not-restored', () => {
    const rows = fidelityRows(run(), run().tests![0]!, {
      ...opts,
      installFailed: 'npm ci exited 1',
    });
    const env = rows.find((r) => r.dimension === 'environment')!;
    expect(env).toMatchObject({ status: 'not-restored' });
    expect(env.reason).toContain('npm ci exited 1');
  });

  it('a recorded seed the runner could not take is not-restored', () => {
    const rows = fidelityRows(run(), run().tests![0]!, {
      ...opts,
      seedApplied: false,
    });
    expect(rows.find((r) => r.dimension === 'seed')!.status).toBe(
      'not-restored',
    );
  });

  it('a recorded null seed is not-recorded', () => {
    const noSeed = run();
    noSeed.replay = { ...noSeed.replay!, seed: null, seed_source: null };
    const rows = fidelityRows(noSeed, noSeed.tests![0]!, {
      ...opts,
      seedApplied: false,
    });
    expect(rows.find((r) => r.dimension === 'seed')!.status).toBe(
      'not-recorded',
    );
  });

  it('order is never claimed restored, even with predecessors', () => {
    for (const withPredecessors of [false, true]) {
      const rows = fidelityRows(run(), run().tests![0]!, {
        ...opts,
        withPredecessors,
      });
      expect(rows.find((r) => r.dimension === 'order')!.status).toBe(
        'not-restored',
      );
    }
  });
});

describe('classifyRepeats', () => {
  it.each([
    [['failed', 'failed', 'failed'], 'reproduced'],
    [['passed', 'passed', 'passed'], 'not-reproduced'],
    [['failed', 'passed', 'failed'], 'intermittent'],
  ] as const)('%j -> %s', (statuses, outcome) => {
    expect(classifyRepeats([...statuses])).toBe(outcome);
  });

  it('counts a flaky attempt as a failure', () => {
    expect(classifyRepeats(['flaky', 'flaky'])).toBe('reproduced');
  });
});

describe('nearestGreen', () => {
  const sha = (n: number): string => String(n).repeat(40);
  const green = (id: string, commit: string, suite = 's'): RunRecord =>
    run({
      run_id: id,
      suite,
      commit_sha: commit,
      tests: [{ test_name: 't', status: 'passed', test_file: 'x' }],
    });
  const failing = run({ run_id: 'fail', commit_sha: sha(0) });
  const firstParent = [sha(0), sha(1), sha(2), sha(3), sha(4), sha(5)];

  it('criterion 7: picks the green run at the fewest first-parent commits back', () => {
    const runs = [failing, green('g5', sha(5)), green('g2', sha(2))];
    expect(nearestGreen(runs, failing, 't', firstParent)).toMatchObject({
      run: { run_id: 'g2' },
      distance: 2,
    });
  });

  it('ignores other suites, other tests, and commits off first-parent history', () => {
    const runs = [
      failing,
      green('other-suite', sha(1), 'other'),
      green('off-history', '9'.repeat(40)),
      run({ run_id: 'red', commit_sha: sha(1) }),
      green('g4', sha(4)),
    ];
    expect(nearestGreen(runs, failing, 't', firstParent)?.run.run_id).toBe(
      'g4',
    );
  });

  it('returns null when no green run exists', () => {
    expect(nearestGreen([failing], failing, 't', firstParent)).toBeNull();
  });
});
