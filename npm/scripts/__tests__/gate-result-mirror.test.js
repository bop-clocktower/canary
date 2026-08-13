/**
 * The mirrored doctrine helper, exercised on the CommonJS side (#704).
 *
 * `npm/src/gate-result.ts` is generated verbatim from
 * `ts/src/core/gate-result.ts` by `scripts/sync-gate-result.mjs` -- the copy is
 * whole-file by construction, so anything added to the engine helper arrives
 * here whether or not this package has a caller for it yet. `pretest` proves
 * the two files are byte-identical; it cannot prove the copy still BEHAVES,
 * because a CommonJS `tsc` target compiles the same source under different
 * settings than the engine's ESM build.
 *
 * So the mirror gets its own behavioural floor. Without one, a helper with no
 * npm-side caller is unexecuted code that a reader has no way to distinguish
 * from dead weight -- and the first npm consumer to reach for it would be the
 * one discovering whether it works.
 *
 * `errnoCode` is the case that matters most: it decides whether a caught error
 * may be absorbed into a skip at all, and getting it wrong in the loose
 * direction turns a genuine defect into a tidy-looking abstention.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { errnoCode, EXIT_ABSTAINED } = require('../../dist/gate-result.js');

const withCode = (code) => Object.assign(new Error('x'), { code });

describe('mirrored gate-result helper (CommonJS)', () => {
  it('exports the abstention exit code', () => {
    assert.equal(EXIT_ABSTAINED, 3);
  });

  it('recognises libuv/POSIX errno codes', () => {
    for (const code of ['ENOENT', 'EACCES', 'EISDIR', 'EMFILE']) {
      assert.equal(errnoCode(withCode(code)), code);
    }
  });

  it('rejects Node programmer-error codes, which must keep throwing', () => {
    for (const code of ['ERR_INVALID_ARG_TYPE', 'MODULE_NOT_FOUND']) {
      assert.equal(errnoCode(withCode(code)), null);
    }
  });

  it('survives every shape a catch can receive', () => {
    assert.equal(errnoCode(withCode(2)), null);
    assert.equal(errnoCode(new Error('no code')), null);
    assert.equal(errnoCode('ENOENT'), null);
    assert.equal(errnoCode(null), null);
    assert.equal(errnoCode(undefined), null);
  });
});
