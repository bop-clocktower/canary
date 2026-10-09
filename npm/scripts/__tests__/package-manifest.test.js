'use strict';
// #1252: every `npm publish` warned
//   "bin[canary]" script name bin/canary.js was invalid and removed
// and told the releaser to run `npm pkg fix`. The bins were never removed:
// npm's normalizer (@npmcli/package-json `binRefs`) rewrites "./bin/x.js" to
// "bin/x.js" and reports ANY rewrite with that "invalid and removed" wording.
// The noise trained people to ignore a warning about missing bins, and
// `npm pkg fix` would rewrite the manifest. So the manifest must already be in
// the shape npm normalizes to: then publish prints no "auto-corrected" banner,
// and a banner that does appear is real news.
//
// The first test runs npm's OWN `fix` pass (the exact call `npm publish`
// makes before printing the banner), using the npm bundled with the running
// Node, so it needs no network. If that npm cannot be located it is skipped
// with the reason named, never passed; the static tests below still run.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PKG_DIR = path.join(__dirname, '..', '..');
const pkg = require('../../package.json');
const BINS = { canary: 'bin/canary.js', 'canary-mcp': 'bin/canary-mcp.js' };

function locateNpmPackageJsonLib() {
  try {
    const root = execFileSync('npm', ['root', '-g'], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
    }).trim();
    const lib = path.join(
      root,
      'npm',
      'node_modules',
      '@npmcli',
      'package-json',
    );
    return fs.existsSync(lib) ? lib : null;
  } catch {
    return null;
  }
}

const npmLib = locateNpmPackageJsonLib();

test(
  "npm's publish-time fix pass changes nothing (no auto-corrected warning)",
  {
    skip: npmLib
      ? false
      : 'npm-bundled @npmcli/package-json not found via `npm root -g`',
  },
  async () => {
    const PackageJson = require(npmLib);
    const changes = [];
    const fixed = await PackageJson.fix(PKG_DIR, { changes });
    assert.deepEqual(
      changes,
      [],
      `npm publish would warn:\n${changes.join('\n')}`,
    );
    assert.deepEqual(
      fixed.content.bin,
      BINS,
      'both bins survive normalization',
    );
  },
);

test('bin paths are declared in npm-normalized form (no leading ./)', () => {
  assert.deepEqual(pkg.bin, BINS);
});

test('every bin target ships in "files"', () => {
  for (const target of Object.values(pkg.bin)) {
    assert.ok(pkg.files.includes(target), `${target} missing from files`);
  }
});

test('repository.url is already in the git+ form npm normalizes to', () => {
  assert.match(pkg.repository.url, /^git\+https:\/\//);
});

test('every bin file is executable in git (mode 100755)', (t) => {
  let out;
  try {
    out = execFileSync(
      'git',
      ['ls-files', '-s', '--', ...Object.values(pkg.bin)],
      {
        cwd: PKG_DIR,
        encoding: 'utf8',
      },
    );
  } catch {
    t.skip('not a git checkout');
    return;
  }
  const lines = out.trim().split('\n').filter(Boolean);
  assert.equal(
    lines.length,
    Object.keys(pkg.bin).length,
    `git tracks every bin:\n${out}`,
  );
  for (const line of lines) assert.match(line, /^100755 /, line);
});
