/**
 * `ts/bin/canary.js` must not exit with output still queued (#1284).
 *
 * On an asynchronous pipe (macOS, Windows) `process.exit` discards the writes
 * that have not drained yet, so a large `--json` payload from a command that
 * exits non-zero reaches `| jq` cut off at the pipe buffer.
 *
 * Two layers, because CI runs on Linux, where pipes are synchronous:
 *   - The mechanism cases run every exit path under a preload that makes
 *     stdout/stderr asynchronous in-process, and assert nothing was pending
 *     when `process.exit` ran. They fail before the fix on any OS.
 *   - The slow-reader case is the original end-to-end repro. It is red on
 *     darwin before the fix and green on Linux either way.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { mkTmp, rmTmp } from './canary-cli-testkit.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'bin', 'canary.js');
const PROBE = join(HERE, 'fixtures', 'async-pipe-exit-probe.cjs');

interface ProbeRun {
  status: number | null;
  stdout: string;
  stderr: string;
  /** What `process.exit` saw; null when the process exited without it. */
  report: { pending: number; code: number } | null;
}

/** Run `node <script> ...args` under the async-pipe probe. */
function runProbed(script: string[], dir: string): ProbeRun {
  const reportPath = join(dir, 'exit-probe.json');
  const res = spawnSync(process.execPath, ['--require', PROBE, ...script], {
    encoding: 'utf-8',
    env: { ...process.env, CANARY_EXIT_PROBE_REPORT: reportPath },
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    report: existsSync(reportPath)
      ? JSON.parse(readFileSync(reportPath, 'utf-8'))
      : null,
  };
}

/** A tests/ directory whose one file trips flake-check, so it exits non-zero. */
function flakyTests(dir: string, count: number): string {
  const tests = join(dir, 'tests');
  mkdirSync(tests, { recursive: true });
  for (let i = 0; i < count; i++) {
    writeFileSync(
      join(tests, `t${i}.spec.ts`),
      `import { test } from '@playwright/test';\ntest('t${i}', async ({ page }) => {\n  await page.waitForTimeout(1000);\n});\n`,
      'utf-8',
    );
  }
  return tests;
}

describe('async-pipe exit probe (guards the guard)', () => {
  it('reports pending writes when a script exits without draining', () => {
    // Positive control: the pre-fix shape, write then exit at once. If the
    // probe stopped seeing this, every case below would pass vacuously.
    const dir = mkTmp();
    try {
      const script = join(dir, 'exit-at-once.cjs');
      writeFileSync(
        script,
        "process.stdout.write('payload');\nprocess.exit(4);\n",
        'utf-8',
      );
      const run = runProbed([script], dir);
      expect(run.report).toEqual({ pending: 1, code: 4 });
      expect(run.stdout).toBe('');
    } finally {
      rmTmp(dir);
    }
  });
});

describe('canary bin drains stdout/stderr before process.exit (#1284)', () => {
  it('CliExitError path: a non-zero flake-check --json exits with nothing pending', () => {
    const dir = mkTmp();
    try {
      const tests = flakyTests(dir, 1);
      const run = runProbed([BIN, 'flake-check', tests, '--json'], dir);
      expect(run.report, run.stderr).not.toBeNull();
      expect(run.report!.code).not.toBe(0);
      expect(run.report!.pending).toBe(0);
      expect(run.status).toBe(run.report!.code);
      expect(() => JSON.parse(run.stdout)).not.toThrow();
    } finally {
      rmTmp(dir);
    }
  });

  it('CommanderError path: --version exits 0 with the banner delivered', () => {
    const dir = mkTmp();
    try {
      const run = runProbed([BIN, '--version'], dir);
      expect(run.report).toEqual({ pending: 0, code: 0 });
      expect(run.stdout).toContain('canary');
    } finally {
      rmTmp(dir);
    }
  });

  it('usage error: stderr is drained too before exit 2', () => {
    const dir = mkTmp();
    try {
      const run = runProbed([BIN, 'no-such-command'], dir);
      expect(run.report).toEqual({ pending: 0, code: 2 });
      expect(run.stderr).not.toBe('');
    } finally {
      rmTmp(dir);
    }
  });
});

function runSlowReader(
  args: string[],
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    child.stdout.pause();
    setTimeout(() => {
      child.stdout.on('data', (c: Buffer) => chunks.push(c));
      child.stdout.resume();
    }, 500);
    child.on('close', (code) =>
      resolvePromise({ code, stdout: Buffer.concat(chunks).toString('utf-8') }),
    );
  });
}

describe('canary bin: a non-zero exit does not truncate piped --json', () => {
  it('delivers the whole flake-check --json payload to a slow pipe reader', async () => {
    const dir = mkTmp();
    try {
      const tests = flakyTests(dir, 400);
      const res = await runSlowReader(['flake-check', tests, '--json']);
      expect(res.code).not.toBe(0);
      expect(() => JSON.parse(res.stdout)).not.toThrow();
      // Guards the guard: a whole payload that fits in one pipe buffer could
      // never have been truncated, so this case would pass vacuously.
      expect(res.stdout.length).toBeGreaterThan(64 * 1024);
    } finally {
      rmTmp(dir);
    }
  }, 60_000);
});
