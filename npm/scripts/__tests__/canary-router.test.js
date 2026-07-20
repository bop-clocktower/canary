const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, forwardToBinary } = require('../../bin/canary.js');
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

  it("routes 'overlay' to the TS router without exec'ing the binary", () => {
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
    assert.equal(
      execCalled,
      false,
      'the Python binary must not run for overlay',
    );
    // overlay list on an empty home succeeds.
    assert.equal(code, 0);
  });

  it('forwards a non-TS command to the binary with unchanged args', () => {
    let received;
    const code = run(['skills', 'list', '--verbose'], {
      execFile: (bin, args) => {
        received = { bin, args };
      },
      existsSync: () => true,
      stderr: { write() {} },
    });
    assert.deepEqual(received.args, ['skills', 'list', '--verbose']);
    assert.ok(
      received.bin.endsWith('canary') || received.bin.endsWith('canary.exe'),
      `expected a canary binary path, got ${received.bin}`,
    );
    assert.equal(code, 0);
  });

  it("propagates the binary's non-zero exit status", () => {
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

  it('reports the npm remedy and exits 1 when the binary is missing', () => {
    let msg = '';
    const code = forwardToBinary(['skills'], {
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
