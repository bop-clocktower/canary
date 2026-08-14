/**
 * `canary uninstall --help` reaches the real handler (#730).
 *
 * `uninstall` is a TS-handled command, so the npm router dispatches it before
 * the bundled engine's commander ever sees the argv. That means the engine's
 * `--help` machinery does not apply here: `--help` arrives as a plain string in
 * `run()`'s argv, and the strict unknown-flag guard rejected it with
 *
 *   canary uninstall: unknown option "--help".
 *
 * — telling a user who asked how the command works that they had used it
 * wrong. Help is a request, not a typo.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const uninstall = require('../../dist/uninstall.js');

/** Collect writes to an out/err sink. */
function collector() {
  let text = '';
  return { write: (s) => (text += s), get: () => text };
}

describe('canary uninstall --help', () => {
  for (const flag of ['--help', '-h']) {
    it(`${flag} is answered, not rejected as an unknown option`, () => {
      const out = collector();
      const err = collector();

      const code = uninstall.run([flag], { out, err });

      assert.equal(code, 0, `${flag} should succeed`);
      assert.doesNotMatch(err.get(), /unknown option/);
      // Asking for help prints the scopes; it must not print an error.
      assert.match(out.get(), /--global/);
      assert.match(out.get(), /--project/);
      assert.match(out.get(), /--all/);
      assert.equal(err.get(), '');
    });
  }

  it('still rejects a genuinely unknown option', () => {
    const out = collector();
    const err = collector();

    const code = uninstall.run(['--nope'], { out, err });

    assert.equal(code, 1);
    assert.match(err.get(), /unknown option "--nope"/);
  });
});
