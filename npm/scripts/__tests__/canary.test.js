const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { getEnginePath } = require('../../bin/canary.js');

describe('getEnginePath', () => {
  it('points at the bundled engine entry cli.js', () => {
    const p = getEnginePath();
    assert.ok(
      p.endsWith(`${path.sep}cli.js`),
      `expected path to end with 'cli.js', got ${p}`,
    );
  });
  it('resolves inside dist/engine/', () => {
    const p = getEnginePath();
    assert.ok(
      p.includes(`${path.sep}dist${path.sep}engine${path.sep}`),
      `expected path under dist/engine/, got ${p}`,
    );
  });
});
