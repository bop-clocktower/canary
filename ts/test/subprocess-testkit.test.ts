/**
 * Contract tests for `subprocess-testkit.ts` (#622).
 *
 * The testkit exists because three separate contract suites had each
 * hand-rolled the same `execFileSync` error normalisation, and each had
 * independently tripped the `ts/test` cyclomatic threshold of 10 doing it.
 * These tests pin the behaviour the three call sites relied on, so the
 * migration is provably behaviour-preserving rather than assumed to be.
 *
 * Every child here is `process.execPath -e '<script>'`, so the suite is
 * offline, deterministic, and needs nothing on PATH.
 */

import { describe, expect, it } from 'vitest';

import { runCapture } from './subprocess-testkit.js';

/** Runs an inline script in a child node, via the testkit under test. */
function node(script: string, options = {}) {
  return runCapture(process.execPath, ['-e', script], options);
}

describe('runCapture', () => {
  it('reports status 0 and the captured stdout on success', () => {
    const result = node('process.stdout.write("hello")');

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('hello');
    expect(result.stderr).toBe('');
    expect(result.output).toBe('hello');
  });

  it('reports the real exit code instead of throwing', () => {
    // The whole reason the testkit exists: a non-zero exit is the case under
    // test for CLI contract suites, so it must be a return value.
    const result = node('process.exit(3)');

    expect(result.status).toBe(3);
  });

  it('captures stdout and stderr separately on a failing run', () => {
    const result = node(
      'process.stdout.write("out");process.stderr.write("err");process.exit(1)',
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('err');
  });

  it('orders output as stdout followed by stderr', () => {
    // Call sites that assert on messages need one stream to search, and the
    // three pre-existing helpers all concatenated in this order.
    const result = node(
      'process.stdout.write("A");process.stderr.write("B");process.exit(1)',
    );

    expect(result.output).toBe('AB');
  });

  it('forwards `input` to the child stdin', () => {
    const result = node(
      'process.stdout.write(require("node:fs").readFileSync(0,"utf-8"))',
      { input: 'piped' },
    );

    expect(result.stdout).toBe('piped');
  });

  it('honours `cwd`', () => {
    const result = node('process.stdout.write(process.cwd())', {
      cwd: process.cwd(),
    });

    expect(result.stdout).toBe(process.cwd());
  });

  it('honours `env`', () => {
    const result = node(
      'process.stdout.write(process.env.CANARY_PROBE ?? "")',
      {
        env: { ...process.env, CANARY_PROBE: 'set' },
      },
    );

    expect(result.stdout).toBe('set');
  });

  it('falls back to `failureStatus` when the child leaves no exit code', () => {
    // A signal kill yields `status: null`. Reporting 0 there would be a
    // false green, so the caller declares what an unknown failure means.
    const result = node('process.kill(process.pid,"SIGKILL")', {
      failureStatus: 7,
    });

    expect(result.status).toBe(7);
  });

  it('defaults `failureStatus` to 1', () => {
    const result = node('process.kill(process.pid,"SIGKILL")');

    expect(result.status).toBe(1);
  });

  it('throws when the binary cannot be spawned', () => {
    // A missing binary is a bug in the test, not a case under test. Folding
    // it into a status would let a typo'd path read as an ordinary failed
    // run — the abstention-as-failure shape this repo keeps closing.
    expect(() =>
      runCapture('./definitely-not-a-real-binary-622', []),
    ).toThrow();
  });
});
