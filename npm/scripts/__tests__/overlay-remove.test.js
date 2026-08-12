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
}
function initSourceRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 't@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'init'], dir);
}
function collector() {
  let t = '';
  return { write: (s) => (t += s), get: () => t };
}

let home, source;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-rm-home-'));
  source = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-rm-src-'));
  initSourceRepo(source);
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(source, { recursive: true, force: true });
});

describe('overlay remove', () => {
  it('deregisters and deletes the clone', () => {
    cmd.add(source, {}, { homeDir: home, out: collector(), err: collector() });
    const name = path.basename(source);
    const dest = registry.clonePath(name, home);
    assert.ok(fs.existsSync(dest));
    const code = cmd.remove(name, {
      homeDir: home,
      out: collector(),
      err: collector(),
    });
    assert.equal(code, 0);
    assert.equal(fs.existsSync(dest), false);
    assert.equal(registry.read(home).overlays.length, 0);
  });

  it('errors on an unknown name and leaves the registry unchanged', () => {
    cmd.add(source, {}, { homeDir: home, out: collector(), err: collector() });
    const err = collector();
    const code = cmd.remove('no-such', {
      homeDir: home,
      out: collector(),
      err,
    });
    assert.equal(code, 1);
    assert.match(err.get(), /no overlay named/);
    assert.equal(registry.read(home).overlays.length, 1);
  });

  // The #675 regression: a user who customised an overlay file must not lose
  // that work to a `remove`. The assertion that matters is the file content
  // still being on disk after the command returns.
  it('refuses to delete a clone with local edits, and the edits survive', () => {
    cmd.add(source, {}, { homeDir: home, out: collector(), err: collector() });
    const name = path.basename(source);
    const dest = registry.clonePath(name, home);
    const edited = path.join(dest, 'README.md');
    fs.writeFileSync(edited, 'my hand-tuned overlay\n');

    const err = collector();
    const code = cmd.remove(name, { homeDir: home, out: collector(), err });

    assert.equal(code, 1);
    assert.equal(fs.existsSync(dest), true);
    assert.equal(fs.readFileSync(edited, 'utf8'), 'my hand-tuned overlay\n');
    assert.equal(registry.read(home).overlays.length, 1);
    assert.match(err.get(), /local modifications/);
    assert.match(
      err.get(),
      new RegExp(dest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    assert.match(err.get(), /--force/);
  });

  it('refuses when the clone is untracked by git (unreadable status)', () => {
    cmd.add(source, {}, { homeDir: home, out: collector(), err: collector() });
    const name = path.basename(source);
    const dest = registry.clonePath(name, home);
    fs.rmSync(path.join(dest, '.git'), { recursive: true, force: true });

    const err = collector();
    const code = cmd.remove(name, { homeDir: home, out: collector(), err });

    assert.equal(code, 1);
    assert.equal(fs.existsSync(dest), true);
    assert.equal(registry.read(home).overlays.length, 1);
    assert.match(err.get(), /cannot read git status/);
    assert.match(err.get(), /--force/);
  });

  it('--force removes a dirty clone', () => {
    cmd.add(source, {}, { homeDir: home, out: collector(), err: collector() });
    const name = path.basename(source);
    const dest = registry.clonePath(name, home);
    fs.writeFileSync(path.join(dest, 'README.md'), 'edited\n');

    const code = cmd.remove(
      name,
      { homeDir: home, out: collector(), err: collector() },
      { force: true },
    );

    assert.equal(code, 0);
    assert.equal(fs.existsSync(dest), false);
    assert.equal(registry.read(home).overlays.length, 0);
  });

  it('deregisters an entry whose clone is already gone', () => {
    cmd.add(source, {}, { homeDir: home, out: collector(), err: collector() });
    const name = path.basename(source);
    const dest = registry.clonePath(name, home);
    fs.rmSync(dest, { recursive: true, force: true });

    const code = cmd.remove(name, {
      homeDir: home,
      out: collector(),
      err: collector(),
    });

    assert.equal(code, 0);
    assert.equal(registry.read(home).overlays.length, 0);
  });
});
