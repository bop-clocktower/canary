const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cmd = require('../../dist/overlay-commands.js');

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r;
}

function initSourceRepo(dir, skillNames) {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 't@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  for (const s of skillNames) {
    const d = path.join(dir, '.canary', 'skills', s);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'SKILL.md'), `# ${s}\n`);
  }
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'init'], dir);
}

function collector() {
  let text = '';
  return { write: (s) => (text += s), get: () => text };
}

let home, source;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-list-home-'));
  source = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-list-src-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(source, { recursive: true, force: true });
});

describe('overlay list', () => {
  it('reports the empty case', () => {
    const out = collector();
    const code = cmd.list({ homeDir: home, out, err: collector() });
    assert.equal(code, 0);
    assert.match(out.get(), /No overlays added/);
  });

  it('shows up-to-date status and skill count for a fresh clone', () => {
    initSourceRepo(source, ['alpha', 'beta']);
    cmd.add(source, {}, { homeDir: home, out: collector(), err: collector() });
    const out = collector();
    const code = cmd.list({ homeDir: home, out, err: collector() });
    assert.equal(code, 0);
    assert.match(out.get(), /status:  up to date/);
    assert.match(out.get(), /skills:  2/);
  });

  it("reports 'N commits behind' after the remote advances and is fetched", () => {
    initSourceRepo(source, ['alpha']);
    cmd.add(source, {}, { homeDir: home, out: collector(), err: collector() });
    // Advance the source, then fetch into the clone (list itself never fetches).
    fs.writeFileSync(path.join(source, 'NEW.md'), 'x\n');
    git(['add', '-A'], source);
    git(['commit', '-q', '-m', 'second'], source);
    const clone = require('../../dist/overlays-registry.js').clonePath(
      path.basename(source),
      home,
    );
    git(['fetch', '-q', 'origin'], clone);
    const out = collector();
    cmd.list({ homeDir: home, out, err: collector() });
    assert.match(out.get(), /status:  1 commit behind/);
  });
});
