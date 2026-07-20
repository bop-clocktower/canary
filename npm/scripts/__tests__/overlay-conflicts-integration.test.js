const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const registry = require('../../dist/overlays-registry.js');
const { checkOverlayConflicts } = require('../../dist/engine-checks.js');
const overlay = require('../../dist/overlay-commands.js');

/**
 * Register an overlay clone under `home` shipping `skills` (dir names), each
 * with a SKILL.md, at the given `precedence`.
 */
function registerOverlay(home, name, skills, precedence = null) {
  const clone = registry.clonePath(name, home);
  const skillsDir = path.join(clone, '.canary', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  for (const s of skills) {
    fs.mkdirSync(path.join(skillsDir, s), { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, s, 'SKILL.md'),
      `---\nname: ${s}\n---\n\n# ${s}\n`,
    );
  }
  registry.write(
    registry.add(registry.read(home), {
      name,
      source: `github:example-org/${name}`,
      ref: null,
      path: clone,
      addedDate: '2026-07-20',
      consent: null,
      consentCommandsHash: null,
      precedence,
    }),
    home,
  );
}

function capture() {
  const chunks = [];
  return {
    out: { write: (s) => (chunks.push(s), true) },
    text: () => chunks.join(''),
  };
}

describe('checkOverlayConflicts (doctor engine check)', () => {
  let home;
  beforeEach(() => (home = fs.mkdtempSync(path.join(os.tmpdir(), 'cflict-'))));
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('passes when no overlays are registered', () => {
    const r = checkOverlayConflicts({ homeDir: home });
    assert.equal(r.status, 'pass');
    assert.match(r.label, /no overlay skill conflicts/);
  });

  it('passes when two overlays ship disjoint skills', () => {
    registerOverlay(home, 'a-ov', ['alpha']);
    registerOverlay(home, 'b-ov', ['beta']);
    assert.equal(checkOverlayConflicts({ homeDir: home }).status, 'pass');
  });

  it('FAILS when two overlays collide with equal precedence', () => {
    registerOverlay(home, 'a-ov', ['dup']);
    registerOverlay(home, 'b-ov', ['dup']);
    const r = checkOverlayConflicts({ homeDir: home });
    assert.equal(r.status, 'fail');
    assert.match(r.label, /dup/);
    assert.match(r.remedy, /precedence/);
  });

  it('passes when a precedence winner is declared', () => {
    registerOverlay(home, 'a-ov', ['dup'], 10);
    registerOverlay(home, 'b-ov', ['dup'], 1);
    const r = checkOverlayConflicts({ homeDir: home });
    assert.equal(r.status, 'pass');
    assert.match(r.label, /resolved by precedence/);
  });
});

describe('overlay list --conflicts', () => {
  let home;
  beforeEach(() => (home = fs.mkdtempSync(path.join(os.tmpdir(), 'cflist-'))));
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('reports none when there are no collisions', () => {
    registerOverlay(home, 'a-ov', ['alpha']);
    const cap = capture();
    const code = overlay.list(
      { homeDir: home, out: cap.out },
      { conflicts: true },
    );
    assert.equal(code, 0);
    assert.match(cap.text(), /No skill-name conflicts/);
  });

  it('lists both sources and exits non-zero on an unresolved collision', () => {
    registerOverlay(home, 'a-ov', ['dup']);
    registerOverlay(home, 'b-ov', ['dup']);
    const cap = capture();
    const code = overlay.list(
      { homeDir: home, out: cap.out },
      { conflicts: true },
    );
    assert.equal(code, 1, 'unresolved collision is a non-zero gate');
    const text = cap.text();
    assert.match(text, /a-ov/);
    assert.match(text, /b-ov/);
    assert.match(text, /UNRESOLVED/);
  });

  it('shows the winner and exits zero when precedence resolves it', () => {
    registerOverlay(home, 'a-ov', ['dup'], 5);
    registerOverlay(home, 'b-ov', ['dup'], 1);
    const cap = capture();
    const code = overlay.list(
      { homeDir: home, out: cap.out },
      { conflicts: true },
    );
    assert.equal(code, 0);
    assert.match(cap.text(), /a-ov wins/);
  });
});
