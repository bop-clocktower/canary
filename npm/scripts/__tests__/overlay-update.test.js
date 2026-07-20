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
function config(dir) {
  git(['config', 'user.email', 't@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
}
function initSourceRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  config(dir);
  const d = path.join(dir, '.canary', 'skills', 'alpha');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'SKILL.md'), '# alpha\n');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'init'], dir);
}
function advance(dir, file) {
  fs.writeFileSync(path.join(dir, file), 'x\n');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', file], dir);
}
function collector() {
  let t = '';
  return { write: (s) => (t += s), get: () => t };
}

let home, source, clone;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-upd-home-'));
  source = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-upd-src-'));
  initSourceRepo(source);
  cmd.add(source, {}, { homeDir: home, out: collector(), err: collector() });
  clone = registry.clonePath(path.basename(source), home);
  config(clone);
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(source, { recursive: true, force: true });
});

describe('overlay update', () => {
  it('fast-forwards when the remote advanced', () => {
    advance(source, 'NEW.md');
    const out = collector();
    const code = cmd.update(null, { homeDir: home, out, err: collector() });
    assert.equal(code, 0);
    assert.match(out.get(), /updated/);
    assert.ok(
      fs.existsSync(path.join(clone, 'NEW.md')),
      'clone should have the new commit',
    );
  });

  it('refuses when the clone has local modifications', () => {
    const skill = path.join(clone, '.canary', 'skills', 'alpha', 'SKILL.md');
    fs.writeFileSync(skill, '# alpha (edited locally)\n');
    advance(source, 'NEW.md');
    const err = collector();
    const code = cmd.update(null, { homeDir: home, out: collector(), err });
    assert.equal(code, 1);
    assert.match(err.get(), /local modifications/);
    assert.match(
      err.get(),
      new RegExp(clone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    // unchanged: NEW.md not pulled
    assert.equal(fs.existsSync(path.join(clone, 'NEW.md')), false);
  });

  it('refuses a non-fast-forward and suggests remove + re-add', () => {
    advance(clone, 'LOCAL.md'); // local commit not on remote
    advance(source, 'REMOTE.md'); // remote diverges
    const err = collector();
    const code = cmd.update(null, { homeDir: home, out: collector(), err });
    assert.equal(code, 1);
    assert.match(err.get(), /cannot fast-forward/);
    assert.match(err.get(), /overlay remove/);
  });

  it('errors on an unknown overlay name', () => {
    const err = collector();
    const code = cmd.update('no-such-overlay', {
      homeDir: home,
      out: collector(),
      err,
    });
    assert.equal(code, 1);
    assert.match(err.get(), /no overlay named/);
  });
});
