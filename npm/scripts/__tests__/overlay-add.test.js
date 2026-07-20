const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cmd = require('../../dist/overlay-commands.js');
const registry = require('../../dist/overlays-registry.js');

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r;
}

/** Create a real git repo with one committed skill, to clone from locally. */
function initSourceRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 't@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  const skill = path.join(dir, '.canary', 'skills', 'demo');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '# demo\n');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'init'], dir);
}

function collector() {
  let text = '';
  return { write: (s) => (text += s), get: () => text };
}

let home, source;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-add-home-'));
  source = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-add-src-'));
  initSourceRepo(source);
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(source, { recursive: true, force: true });
});

describe('overlay add', () => {
  it('clones a local source and registers it', () => {
    const out = collector();
    const code = cmd.add(
      source,
      {},
      { homeDir: home, out, err: collector(), now: () => '2026-07-16' },
    );
    assert.equal(code, 0);
    const name = path.basename(source);
    const dest = registry.clonePath(name, home);
    assert.ok(
      fs.existsSync(path.join(dest, '.canary', 'skills', 'demo', 'SKILL.md')),
    );
    const entry = registry.get(registry.read(home), name);
    assert.ok(entry, 'expected a registry entry');
    assert.equal(entry.path, dest);
    assert.equal(entry.consent, null);
    assert.equal(entry.addedDate, '2026-07-16');
  });

  it('is idempotent — re-adding is a no-op with an update hint', () => {
    cmd.add(
      source,
      {},
      {
        homeDir: home,
        out: collector(),
        err: collector(),
        now: () => '2026-07-16',
      },
    );
    const out = collector();
    const code = cmd.add(source, {}, { homeDir: home, out, err: collector() });
    assert.equal(code, 0);
    assert.match(out.get(), /already added/);
    assert.equal(registry.read(home).overlays.length, 1);
  });

  it('leaves nothing registered and no partial clone when the clone fails', () => {
    const err = collector();
    const bad = path.join(os.tmpdir(), 'canary-does-not-exist-xyz.git');
    const code = cmd.add(bad, {}, { homeDir: home, out: collector(), err });
    assert.equal(code, 1);
    assert.equal(registry.read(home).overlays.length, 0);
    assert.equal(
      fs.existsSync(registry.clonePath('canary-does-not-exist-xyz', home)),
      false,
    );
    assert.match(err.get(), /clone failed/);
  });

  it('rejects a malformed source spec', () => {
    const err = collector();
    const code = cmd.add(
      'not-a-source',
      {},
      { homeDir: home, out: collector(), err },
    );
    assert.equal(code, 1);
    assert.match(err.get(), /accepted forms/);
  });

  it('refuses when the clone dir exists but is unregistered', () => {
    const name = path.basename(source);
    fs.mkdirSync(registry.clonePath(name, home), { recursive: true });
    const err = collector();
    const code = cmd.add(source, {}, { homeDir: home, out: collector(), err });
    assert.equal(code, 1);
    assert.match(err.get(), /already exists but is not registered/);
  });
});

describe('classifyCloneFailure', () => {
  it('maps common git stderr to a reason', () => {
    assert.equal(
      cmd.classifyCloneFailure({
        status: 128,
        stdout: '',
        stderr: 'fatal: could not resolve host: github.com',
      }),
      'network unreachable',
    );
    assert.equal(
      cmd.classifyCloneFailure({
        status: 128,
        stdout: '',
        stderr: "fatal: Authentication failed for 'https://...'",
      }),
      'authentication denied',
    );
    assert.equal(
      cmd.classifyCloneFailure({
        status: 128,
        stdout: '',
        stderr: 'fatal: repository not found',
      }),
      'repository not found',
    );
    assert.equal(
      cmd.classifyCloneFailure({
        status: 127,
        stdout: '',
        stderr: 'spawn git ENOENT',
      }),
      'git not found on PATH',
    );
  });
});
