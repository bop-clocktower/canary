const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { getServerPath, main } = require('../../bin/canary-mcp.js');

describe('getServerPath', () => {
  it('points at the bundled engine mcp-server.js', () => {
    const p = getServerPath();
    assert.ok(
      p.endsWith(`${path.sep}mcp-server.js`),
      `expected path to end with 'mcp-server.js', got ${p}`,
    );
  });
  it('resolves inside dist/engine/', () => {
    const p = getServerPath();
    assert.ok(
      p.includes(`${path.sep}dist${path.sep}engine${path.sep}`),
      `expected path under dist/engine/, got ${p}`,
    );
  });
});

describe('main', () => {
  it('exits 1 with a reinstall hint when the engine is missing', async () => {
    let out = '';
    const code = await main({
      serverPath: path.join(os.tmpdir(), 'nope', 'mcp-server.js'),
      stderr: { write: (s) => (out += s) },
    });
    assert.equal(code, 1);
    assert.match(out, /reinstall/i);
    // stdout carries JSON-RPC; the failure must go to stderr only.
    assert.match(out, /mcp-server\.js/);
  });
  it('imports the server module and awaits runStdio', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-mcp-'));
    const fixture = path.join(dir, 'mcp-server.mjs');
    const flag = path.join(dir, 'ran');
    fs.writeFileSync(
      fixture,
      `import { writeFileSync } from 'node:fs';\n` +
        `export function runStdio() { writeFileSync(${JSON.stringify(flag)}, 'yes'); }\n`,
    );
    try {
      const code = await main({ serverPath: fixture });
      assert.equal(code, 0);
      assert.equal(fs.readFileSync(flag, 'utf-8'), 'yes');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('packaging', () => {
  const pkg = require('../../package.json');
  it('declares the canary-mcp bin', () => {
    assert.equal(pkg.bin['canary-mcp'], './bin/canary-mcp.js');
  });
  it('ships the bin in files', () => {
    assert.ok(pkg.files.includes('bin/canary-mcp.js'));
  });
});
