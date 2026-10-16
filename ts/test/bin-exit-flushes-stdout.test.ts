/**
 * `ts/bin/canary.js` must not exit with output still queued (#1284).
 *
 * When stdout is a pipe or socket, a write that the kernel buffer cannot take
 * at once is queued in libuv, and `process.exit` discards the queue. A large
 * `--json` payload from a command that exits non-zero then reaches `| jq` cut
 * off. Measured with a slow reader: macOS keeps the first 65536 bytes, Linux
 * the first 146176. A smaller payload fits the buffer, so CI saw nothing.
 *
 * Two layers:
 *   - Mechanism cases run every exit branch of the real bin file under a
 *     preload that makes stdout/stderr asynchronous in-process, and assert
 *     nothing was pending when `process.exit` ran. That fails before the fix
 *     whatever the payload size or platform buffer. The bin is copied next to
 *     stub `dist/` modules, because the TS engine CI job runs the suite
 *     without building `ts/dist` (the bin's only import).
 *   - Slow-reader cases are the end-to-end repro: a 500 KB stub payload
 *     always, and a real `flake-check --json` (~300 KB) when `ts/dist` is
 *     built. Both are past the Linux buffer, so they are red before the fix on
 *     CI as well as on macOS.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mkTmp, rmTmp } from './canary-cli-testkit.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_ROOT = join(HERE, '..');
const BIN = join(TS_ROOT, 'bin', 'canary.js');
const PROBE = join(HERE, 'fixtures', 'async-pipe-exit-probe.cjs');
const DIST_BUILT = existsSync(join(TS_ROOT, 'dist', 'cli.js'));
/** Larger than any platform's pipe/socket buffer seen so far (Linux 146176). */
const PAST_PIPE_BUFFER = 256 * 1024;

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
  const report = existsSync(reportPath)
    ? JSON.parse(readFileSync(reportPath, 'utf-8'))
    : null;
  rmTmp(reportPath);
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, report };
}

/**
 * Spawn `node <args>` and read its stdout only after 500 ms, like a busy
 * `| jq`, so the child's writes back up in the pipe.
 *
 * The `readable` listener is attached at once on purpose. A stream with no
 * listener when the child exits is resumed and drained into the void by
 * child_process itself, so an early-exiting child would read as 0 bytes
 * whether or not it flushed: a harness artifact, not the bug.
 */
function readSlowly(
  args: string[],
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let reading = false;
    const drain = (): void => {
      if (!reading) return;
      let chunk: Buffer | null;
      while ((chunk = child.stdout.read() as Buffer | null) !== null) {
        chunks.push(chunk);
      }
    };
    child.stdout.on('readable', drain);
    setTimeout(() => {
      reading = true;
      drain();
    }, 500);
    child.on('close', (code) =>
      resolvePromise({
        code,
        stdout: Buffer.concat(chunks).toString('utf-8'),
      }),
    );
  });
}

/**
 * The real bin file, copied into `<dir>/bin/` beside stub `<dir>/dist/`
 * modules whose command writes a JSON document and then leaves through the
 * branch named by argv[0] (`big` writes ~500 KB, then exits like `business`).
 * node_modules is linked so the bin's `commander` import is the same
 * CommanderError class the stub throws.
 */
function stubbedBin(dir: string): string {
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'dist'));
  symlinkSync(
    join(TS_ROOT, 'node_modules'),
    join(dir, 'node_modules'),
    'junction',
  );
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  copyFileSync(BIN, join(dir, 'bin', 'canary.js'));
  writeFileSync(
    join(dir, 'dist', 'cli-common.js'),
    'export class CliExitError extends Error {\n' +
      '  constructor(code) { super(`exit ${code}`); this.code = code; }\n' +
      '}\n',
  );
  writeFileSync(
    join(dir, 'dist', 'cli.js'),
    "import { CommanderError } from 'commander';\n" +
      "import { CliExitError } from './cli-common.js';\n" +
      'export function createCanaryCommand() {\n' +
      '  return {\n' +
      '    async parseAsync(argv) {\n' +
      '      const mode = argv[0];\n' +
      "      const pad = mode === 'big' ? 'x'.repeat(500000) : undefined;\n" +
      "      process.stdout.write(JSON.stringify({ mode, pad }) + '\\n');\n" +
      "      if (mode === 'business' || mode === 'big') throw new CliExitError(3);\n" +
      "      if (mode === 'usage') throw new CommanderError(2, 'commander.unknownCommand', 'bad usage');\n" +
      "      if (mode === 'crash') throw new Error('boom');\n" +
      '    },\n' +
      '  };\n' +
      '}\n',
  );
  return join(dir, 'bin', 'canary.js');
}

/** A tests/ directory whose files trip flake-check, so it exits non-zero. */
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
    // probe stopped seeing this, every mechanism case would pass vacuously.
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

  it('the slow reader sees a truncation when a script exits without draining', async () => {
    // Positive control for the end-to-end layer: a bare write-then-exit past
    // the pipe buffer must come back short, on this platform, through this
    // reader. If it stopped doing so, the slow-reader cases would be vacuous.
    const dir = mkTmp();
    try {
      const script = join(dir, 'exit-at-once.cjs');
      writeFileSync(
        script,
        `process.stdout.write('x'.repeat(${PAST_PIPE_BUFFER * 2}));\nprocess.exit(1);\n`,
        'utf-8',
      );
      const res = await readSlowly([script]);
      expect(res.stdout.length).toBeLessThan(PAST_PIPE_BUFFER * 2);
    } finally {
      rmTmp(dir);
    }
  });
});

describe('canary bin drains stdout/stderr before process.exit (#1284)', () => {
  let dir: string;
  let bin: string;
  beforeAll(() => {
    dir = mkTmp();
    bin = stubbedBin(dir);
  });
  afterAll(() => rmTmp(dir));

  it('CliExitError: exits with the business code and nothing pending', () => {
    const run = runProbed([bin, 'business'], dir);
    expect(run.report, run.stderr).toEqual({ pending: 0, code: 3 });
    expect(run.status).toBe(3);
    expect(run.stdout).toBe('{"mode":"business"}\n');
  });

  it('CommanderError: exits with the usage code and nothing pending', () => {
    const run = runProbed([bin, 'usage'], dir);
    expect(run.report, run.stderr).toEqual({ pending: 0, code: 2 });
    expect(run.stdout).toBe('{"mode":"usage"}\n');
  });

  it('unexpected crash: the error reaches stderr before exit 1', () => {
    const run = runProbed([bin, 'crash'], dir);
    expect(run.report).toEqual({ pending: 0, code: 1 });
    expect(run.stderr).toMatch(/boom/);
  });

  it('success: no forced exit, output delivered', () => {
    const run = runProbed([bin, 'ok'], dir);
    expect(run.report).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('{"mode":"ok"}\n');
  });

  it('delivers a 500 KB payload whole to a slow pipe reader before exit 3', async () => {
    const res = await readSlowly([bin, 'big']);
    expect(res.code).toBe(3);
    expect(() => JSON.parse(res.stdout)).not.toThrow();
    expect(res.stdout.length).toBeGreaterThan(PAST_PIPE_BUFFER);
  });
});

describe.skipIf(!DIST_BUILT)('real ts/dist (needs `npm run build`)', () => {
  it('a non-zero flake-check --json exits with nothing pending', () => {
    const dir = mkTmp();
    try {
      const tests = flakyTests(dir, 1);
      const run = runProbed([BIN, 'flake-check', tests, '--json'], dir);
      expect(run.report, run.stderr).not.toBeNull();
      expect(run.report!.code).not.toBe(0);
      expect(run.report!.pending).toBe(0);
      expect(() => JSON.parse(run.stdout)).not.toThrow();
    } finally {
      rmTmp(dir);
    }
  });

  it('--version and an unknown command drain before exiting 0 and 2', () => {
    const dir = mkTmp();
    try {
      const version = runProbed([BIN, '--version'], dir);
      expect(version.report).toEqual({ pending: 0, code: 0 });
      expect(version.stdout).toContain('canary');
      const usage = runProbed([BIN, 'no-such-command'], dir);
      expect(usage.report).toEqual({ pending: 0, code: 2 });
      expect(usage.stderr).not.toBe('');
    } finally {
      rmTmp(dir);
    }
  });

  it('delivers the whole flake-check --json payload to a slow pipe reader', async () => {
    const dir = mkTmp();
    try {
      const tests = flakyTests(dir, 1000);
      const res = await readSlowly([BIN, 'flake-check', tests, '--json']);
      expect(res.code).not.toBe(0);
      expect(() => JSON.parse(res.stdout)).not.toThrow();
      // Guards the guard: a payload inside the pipe buffer could never have
      // been truncated, so the parse above would pass vacuously.
      expect(res.stdout.length).toBeGreaterThan(PAST_PIPE_BUFFER);
    } finally {
      rmTmp(dir);
    }
  }, 60_000);
});
