const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { run } = require('../../bin/canary.js');
const { isTsCommand, TS_COMMANDS, route } = require('../../dist/router.js');

describe('doctor router wiring', () => {
  it("recognizes 'doctor' as TS-handled", () => {
    assert.equal(isTsCommand(['doctor']), true);
    assert.equal(isTsCommand(['doctor', '--audience', 'alpha']), true);
    assert.ok(TS_COMMANDS.includes('doctor'));
  });

  it("route('doctor') returns a value, not null (does not fall through)", async () => {
    const hermetic = {
      out: { write() {} },
      err: { write() {} },
      homeDir: os.tmpdir(),
      cwd: os.tmpdir(),
      getLatestVersion: async () => null,
      git: () => ({ status: 0, stdout: 'git version test', stderr: '' }),
    };
    const result = route(['doctor'], hermetic);
    assert.notEqual(result, null);
    assert.equal(await result, 0);
  });

  it("routes 'doctor' to the TS handler without exec'ing the Python binary", async () => {
    let execCalled = false;
    const code = await run(['doctor'], {
      execFile: () => {
        execCalled = true;
      },
      existsSync: () => true,
      out: { write() {} },
      stderr: { write() {} },
      homeDir: os.tmpdir(),
      cwd: os.tmpdir(),
      getLatestVersion: async () => null,
      git: () => ({ status: 0, stdout: 'git version test', stderr: '' }),
    });
    assert.equal(
      execCalled,
      false,
      'the Python binary must not run for doctor',
    );
    assert.equal(code, 0);
  });

  it('still forwards a non-TS command to the binary unchanged', () => {
    let received;
    const code = run(['skills', 'list'], {
      execFile: (bin, args) => {
        received = { bin, args };
      },
      existsSync: () => true,
      stderr: { write() {} },
    });
    assert.deepEqual(received.args, ['skills', 'list']);
    assert.equal(code, 0);
  });
});
