const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, forwardToEngine } = require('../../bin/canary.js');
const { isTsCommand, TS_COMMANDS } = require('../../dist/router.js');

describe('router table', () => {
  it("recognizes 'overlay' as TS-handled", () => {
    assert.equal(isTsCommand(['overlay', 'add', 'x']), true);
    assert.ok(TS_COMMANDS.includes('overlay'));
  });
  it('treats forwarded commands as not TS-handled', () => {
    assert.equal(isTsCommand(['skills', 'list']), false);
    assert.equal(isTsCommand([]), false);
  });
});

describe('shim router dispatch', () => {
  let home;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-shim-home-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("routes 'overlay' to the TS router without exec'ing the engine", () => {
    let execCalled = false;
    const code = run(['overlay', 'list'], {
      execFile: () => {
        execCalled = true;
      },
      existsSync: () => true,
      homeDir: home,
      out: { write() {} },
      stderr: { write() {} },
    });
    assert.equal(execCalled, false, 'the engine must not run for overlay');
    // overlay list on an empty home succeeds.
    assert.equal(code, 0);
  });

  it('forwards a non-TS command to the engine with unchanged args', () => {
    let received;
    const code = run(['skills', 'list', '--verbose'], {
      execFile: (bin, args) => {
        received = { bin, args };
      },
      existsSync: () => true,
      stderr: { write() {} },
    });
    // The engine runs under `node <enginePath> ...argv`, so the first exec arg
    // is the engine entry and the remainder is the verbatim argv.
    assert.equal(received.bin, process.execPath);
    assert.ok(
      received.args[0].endsWith(`${path.sep}cli.js`),
      `expected engine entry as first arg, got ${received.args[0]}`,
    );
    assert.deepEqual(received.args.slice(1), ['skills', 'list', '--verbose']);
    assert.equal(code, 0);
  });

  it("propagates the engine's non-zero exit status", () => {
    const code = run(['generate'], {
      execFile: () => {
        const err = new Error('child failed');
        err.status = 3;
        throw err;
      },
      existsSync: () => true,
      stderr: { write() {} },
    });
    assert.equal(code, 3);
  });

  it('reports the npm remedy and exits 1 when the engine is missing', () => {
    let msg = '';
    const code = forwardToEngine(['skills'], {
      existsSync: () => false,
      stderr: {
        write(s) {
          msg += s;
        },
      },
    });
    assert.equal(code, 1);
    assert.match(msg, /npm install -g canary-test-cli/);
  });
});
