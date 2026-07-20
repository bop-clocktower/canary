const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const reg = require('../../dist/overlays-registry.js');

let home;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-reg-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function entry(name) {
  return {
    name,
    source: `github:example-org/${name}`,
    ref: null,
    path: reg.clonePath(name, home),
    addedDate: '2026-07-16',
    consent: null,
  };
}

describe('overlays-registry paths', () => {
  it('resolves registry + overlays dir under ~/.canary', () => {
    assert.equal(
      reg.registryPath(home),
      path.join(home, '.canary', 'overlays.json'),
    );
    assert.equal(reg.overlaysDir(home), path.join(home, '.canary', 'overlays'));
    assert.equal(
      reg.clonePath('a-b', home),
      path.join(home, '.canary', 'overlays', 'a-b'),
    );
  });
});

describe('overlays-registry read', () => {
  it('missing file → empty registry (not an error)', () => {
    const r = reg.read(home);
    assert.deepEqual(r, { schemaVersion: reg.SCHEMA_VERSION, overlays: [] });
  });
  it('malformed JSON → RegistryError', () => {
    fs.mkdirSync(path.join(home, '.canary'), { recursive: true });
    fs.writeFileSync(reg.registryPath(home), '{ not json', 'utf8');
    assert.throws(() => reg.read(home), reg.RegistryError);
  });
  it('wrong shape (no overlays array) → RegistryError', () => {
    fs.mkdirSync(path.join(home, '.canary'), { recursive: true });
    fs.writeFileSync(
      reg.registryPath(home),
      JSON.stringify({ schemaVersion: 1 }),
      'utf8',
    );
    assert.throws(() => reg.read(home), reg.RegistryError);
  });
});

describe('overlays-registry write / round-trip', () => {
  it('stamps schema version and round-trips', () => {
    const r = reg.add(reg.emptyRegistry(), entry('example-org-a'));
    reg.write(r, home);
    const back = reg.read(home);
    assert.equal(back.schemaVersion, reg.SCHEMA_VERSION);
    assert.equal(back.overlays.length, 1);
    assert.equal(back.overlays[0].name, 'example-org-a');
    assert.equal(back.overlays[0].consent, null);
    // trailing newline written
    assert.match(fs.readFileSync(reg.registryPath(home), 'utf8'), /\}\n$/);
  });
  it('write is atomic — no leftover .tmp', () => {
    reg.write(reg.add(reg.emptyRegistry(), entry('x-y')), home);
    assert.equal(fs.existsSync(`${reg.registryPath(home)}.tmp`), false);
  });
});

describe('overlays-registry in-memory ops', () => {
  it('add rejects duplicates', () => {
    const r = reg.add(reg.emptyRegistry(), entry('dup'));
    assert.throws(() => reg.add(r, entry('dup')), reg.RegistryError);
  });
  it('get returns the entry or null', () => {
    const r = reg.add(reg.emptyRegistry(), entry('found'));
    assert.equal(reg.get(r, 'found').name, 'found');
    assert.equal(reg.get(r, 'missing'), null);
  });
  it('remove reports whether it existed and drops the entry', () => {
    let r = reg.add(reg.emptyRegistry(), entry('gone'));
    const hit = reg.remove(r, 'gone');
    assert.equal(hit.removed, true);
    assert.equal(hit.registry.overlays.length, 0);
    const miss = reg.remove(hit.registry, 'gone');
    assert.equal(miss.removed, false);
  });
});
