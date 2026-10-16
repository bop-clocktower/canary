/**
 * The published package must not exit with output still queued (#1356, #1284).
 *
 * On an asynchronous pipe (macOS, Windows) `process.exit` discards the writes
 * that have not drained yet: `canary testtracker push --dry-run | jq` got the
 * first 64 KiB of a 330 KB payload. Two exits ship in this package:
 *
 *   - bin/canary.js `main()`, which exits on every run, success included. It
 *     carries the TS-routed commands (overlay, doctor, uninstall, testtracker).
 *   - dist/engine/cli.js, generated from scripts/engine-runner.mjs. Every other
 *     command is forwarded to it, so it is the exit those commands take.
 *
 * Each runs under a preload that makes stdout/stderr asynchronous in-process
 * (ts/test/fixtures/async-pipe-exit-probe.cjs, shared with the engine's own
 * bin test), so the assertion "nothing was pending when process.exit ran"
 * fails before the fix on any OS, Linux CI included.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NPM_ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(NPM_ROOT, 'bin', 'canary.js');
const PROBE = path.resolve(
  NPM_ROOT,
  '..',
  'ts',
  'test',
  'fixtures',
  'async-pipe-exit-probe.cjs',
);

/** Run `node <script> ...args` under the async-pipe probe. */
function runProbed(script, args, { cwd, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-exit-probe-'));
  const reportPath = path.join(dir, 'report.json');
  try {
    const res = spawnSync(
      process.execPath,
      ['--require', PROBE, script, ...args],
      {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, ...env, CANARY_EXIT_PROBE_REPORT: reportPath },
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const report = fs.existsSync(reportPath)
      ? JSON.parse(fs.readFileSync(reportPath, 'utf8'))
      : null;
    return {
      status: res.status,
      stdout: res.stdout,
      stderr: res.stderr,
      report,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('bin/canary.js drains before process.exit (#1356)', () => {
  let home;
  before(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-exit-home-'));
  });
  after(() => fs.rmSync(home, { recursive: true, force: true }));
  const homeEnv = () => ({ HOME: home, USERPROFILE: home });

  it('has a probe to run under (a missing preload would fail every spawn)', () => {
    assert.ok(fs.existsSync(PROBE), `probe missing at ${PROBE}`);
  });

  it('success path: overlay list exits 0 with stdout delivered', () => {
    const run = runProbed(BIN, ['overlay', 'list'], { env: homeEnv() });
    assert.deepEqual(run.report, { pending: 0, code: 0 }, run.stderr);
    assert.match(run.stdout, /No overlays added/);
  });

  it('failure path: overlay remove of an unknown name drains stderr before exit 1', () => {
    const run = runProbed(BIN, ['overlay', 'remove', 'nope'], {
      env: homeEnv(),
    });
    assert.deepEqual(run.report, { pending: 0, code: 1 });
    assert.match(run.stderr, /no overlay named "nope"/);
  });

  it('delivers a large testtracker push --dry-run payload to a slow pipe reader', async () => {
    // The #1356 repro, end to end. Red on darwin before the fix (65536 of
    // ~263 KB); Linux pipes are synchronous, so it is green on CI either way
    // and the probe cases above carry the portable proof.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-exit-junit-'));
    try {
      const cases = [];
      for (let i = 0; i < 600; i++) {
        cases.push(
          `<testcase classname="suite/file-${i}.test.ts" name="case number ${i} with a reasonably long descriptive title" time="0.01"/>`,
        );
      }
      const junit = path.join(dir, 'junit.xml');
      fs.writeFileSync(
        junit,
        `<?xml version="1.0"?><testsuites><testsuite name="s" tests="600">${cases.join('')}</testsuite></testsuites>`,
      );
      const env = { ...process.env, ...homeEnv() };
      delete env.CANARY_INGEST_URL;
      delete env.CANARY_INGEST_TOKEN;
      const res = await new Promise((resolve) => {
        const child = spawn(
          process.execPath,
          [
            BIN,
            'testtracker',
            'push',
            '--junit',
            junit,
            '--suite',
            'x',
            '--dry-run',
          ],
          { env, stdio: ['ignore', 'pipe', 'ignore'] },
        );
        const chunks = [];
        child.stdout.pause();
        setTimeout(() => {
          child.stdout.on('data', (c) => chunks.push(c));
          child.stdout.resume();
        }, 500);
        child.on('close', (code) =>
          resolve({ code, stdout: Buffer.concat(chunks).toString('utf8') }),
        );
      });
      assert.equal(res.code, 0);
      assert.doesNotThrow(() => JSON.parse(res.stdout));
      // Guards the guard: a payload inside one pipe buffer proves nothing.
      assert.ok(res.stdout.length > 64 * 1024, `${res.stdout.length} bytes`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('generated engine runner drains before process.exit (#1356)', () => {
  // The runner is written next to stub command modules, so every exit branch
  // can be driven without building the engine (CI's npm job does not).
  // node_modules is linked in so the runner's `commander` import resolves to
  // the same CommanderError class the stub throws.
  let dir;
  before(async () => {
    const { RUNNER } = await import('../engine-runner.mjs');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-engine-runner-'));
    fs.symlinkSync(
      path.join(NPM_ROOT, 'node_modules'),
      path.join(dir, 'node_modules'),
      'junction',
    );
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
    fs.writeFileSync(path.join(dir, 'cli.js'), RUNNER);
    fs.writeFileSync(
      path.join(dir, 'cli-common.js'),
      'export class CliExitError extends Error {\n' +
        '  constructor(code) { super(`exit ${code}`); this.code = code; }\n' +
        '}\n',
    );
    fs.writeFileSync(
      path.join(dir, 'cli.core.js'),
      "import { CommanderError } from 'commander';\n" +
        "import { CliExitError } from './cli-common.js';\n" +
        'export function createCanaryCommand() {\n' +
        '  return {\n' +
        '    async parseAsync(argv) {\n' +
        '      const mode = argv[0];\n' +
        "      process.stdout.write(JSON.stringify({ mode }) + '\\n');\n" +
        "      if (mode === 'business') throw new CliExitError(3);\n" +
        "      if (mode === 'usage') throw new CommanderError(2, 'commander.unknownCommand', 'bad usage');\n" +
        "      if (mode === 'crash') throw new Error('boom');\n" +
        '    },\n' +
        '  };\n' +
        '}\n',
    );
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const runner = () => path.join(dir, 'cli.js');

  it('CliExitError: exits with the business code and nothing pending', () => {
    const run = runProbed(runner(), ['business']);
    assert.deepEqual(run.report, { pending: 0, code: 3 }, run.stderr);
    assert.equal(run.stdout, '{"mode":"business"}\n');
  });

  it('CommanderError: exits with the usage code and nothing pending', () => {
    const run = runProbed(runner(), ['usage']);
    assert.deepEqual(run.report, { pending: 0, code: 2 }, run.stderr);
    assert.equal(run.stdout, '{"mode":"usage"}\n');
  });

  it('unexpected crash: the error reaches stderr before exit 1', () => {
    const run = runProbed(runner(), ['crash']);
    assert.deepEqual(run.report, { pending: 0, code: 1 });
    assert.match(run.stderr, /boom/);
  });

  it('success: no forced exit, output delivered', () => {
    const run = runProbed(runner(), ['ok']);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, '{"mode":"ok"}\n');
  });
});
