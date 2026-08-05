/**
 * Runtime Node-floor guard for the CLI entry points (#559).
 *
 * `engines` is ADVISORY. Verified empirically, not assumed: installing a package
 * declaring `engines.node: ">=99"` on Node 24 exits 0 with only
 * `npm warn EBADENGINE`. It becomes a hard error only under
 * `engine-strict=true`, which almost nobody sets. So raising the published floor
 * to `>=22` is a claim, not a guard — a Node 20 user still installs, and their
 * first real signal used to be whatever the bundled engine's first unsupported
 * syntax produced.
 *
 * These tests pin the guard that closes that gap, plus the two properties that
 * make it actually work:
 *
 * 1. The floor is READ FROM `package.json` `engines.node`, not hardcoded.
 *    A hardcoded copy would be a fourth place to drift (manifest, README badge,
 *    README prose, guard) and the whole point of #559 was that those diverge.
 *
 * 2. The guard runs BEFORE the entry point requires the bundled engine.
 *    `bin/canary.js` requires `../dist/router.js` at module load; the engine is
 *    compiled for Node 22, so on Node 20 that require can throw SyntaxError
 *    before any of our code runs. A guard placed after it would never execute on
 *    exactly the versions it exists to catch — a guard that only works when it
 *    is not needed.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { checkNodeFloor, MIN_NODE_MAJOR } = require('../../bin/canary.js');

const PKG = require('../../package.json');

describe('MIN_NODE_MAJOR', () => {
  it('is derived from package.json engines.node, not hardcoded', () => {
    const declared = /^>=\s*(\d+)/.exec(PKG.engines.node);
    assert.ok(declared, `engines.node '${PKG.engines.node}' is not '>=N'`);
    assert.equal(
      MIN_NODE_MAJOR,
      Number(declared[1]),
      'the guard floor must track engines.node so there is one source of truth',
    );
  });
});

describe('checkNodeFloor', () => {
  it('returns null on exactly the floor', () => {
    assert.equal(checkNodeFloor('22.0.0', 22), null);
  });

  it('returns null above the floor', () => {
    assert.equal(checkNodeFloor('24.16.0', 22), null);
  });

  it('returns a message below the floor', () => {
    const msg = checkNodeFloor('20.11.0', 22);
    assert.ok(msg, 'expected a message on Node 20 against a floor of 22');
    assert.match(msg, /22/, 'the message must state the required version');
    assert.match(msg, /20\.11\.0/, 'the message must state what is running');
  });

  it('names canary and how to fix it, not just the numbers', () => {
    const msg = checkNodeFloor('18.0.0', 22);
    assert.match(
      msg,
      /canary/i,
      'a bare version error does not say who wants it',
    );
    assert.match(
      msg,
      /nvm|volta|mise|upgrade/i,
      'the message should point at a remedy, not just a complaint',
    );
  });

  it('handles a prerelease/odd version string without crashing', () => {
    // process.versions.node has no 'v' prefix, but be defensive: a garbled
    // version must not turn the guard itself into the failure.
    assert.equal(checkNodeFloor('23.0.0-nightly', 22), null);
    assert.ok(checkNodeFloor('21.0.0-nightly', 22));
  });

  it('abstains rather than blocks on an unparseable version', () => {
    // If we cannot tell, do not stop the user — but do not claim a pass either.
    // Returning null here is deliberate: a false block is worse than letting a
    // weird runtime through to the real error.
    assert.equal(checkNodeFloor('not-a-version', 22), null);
  });
});

describe('guard ordering in bin/canary.js', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'bin', 'canary.js'),
    'utf-8',
  );

  it('checks the Node floor before requiring the bundled engine', () => {
    const guardAt = source.indexOf('checkNodeFloor(process.versions.node');
    const engineAt = source.indexOf("require('../dist/router.js')");

    assert.ok(
      guardAt >= 0,
      'no live checkNodeFloor(process.versions.node) call',
    );
    assert.ok(engineAt >= 0, "expected a require of '../dist/router.js'");
    assert.ok(
      guardAt < engineAt,
      'the Node-floor guard must appear BEFORE the require of the bundled ' +
        'engine. The engine is compiled for the floor version, so requiring it ' +
        'first can throw SyntaxError on an older Node and the guard would ' +
        'never run on the versions it exists to catch.',
    );
  });

  it('uses only syntax that parses on the oldest Node it must warn', () => {
    // The guard has to run on Node it does not support, so the top of this file
    // cannot use anything newer than the versions being rejected. `??`, `?.`,
    // and class fields are all fine on 18+, but keep the guard conservative.
    const head = source.slice(
      0,
      source.indexOf("require('../dist/router.js')"),
    );
    assert.doesNotMatch(
      head,
      /#[a-zA-Z]/,
      'no private class fields above the engine require',
    );
    assert.doesNotMatch(
      head,
      /\|\|=|&&=/,
      'no logical assignment operators above the engine require',
    );
  });
});
