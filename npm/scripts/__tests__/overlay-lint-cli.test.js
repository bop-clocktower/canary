const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const overlay = require('../../dist/overlay-commands.js');
const registry = require('../../dist/overlays-registry.js');

function capture() {
  const chunks = [];
  return {
    out: { write: (s) => (chunks.push(s), true) },
    err: { write: (s) => (chunks.push(s), true) },
    text: () => chunks.join(''),
  };
}

function writeSkill(overlayDir, name, fm) {
  const dir = path.join(overlayDir, '.canary', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  const body = Object.entries(fm)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`)
    .join('\n');
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\n${body}\n---\n\n# ${name}\n`,
  );
}

describe('overlay lint (CLI command)', () => {
  let home, proj;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-home-'));
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-proj-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  });

  it('usage error (exit 1) with no target', () => {
    const cap = capture();
    const code = overlay.lint(undefined, { homeDir: home, ...cap });
    assert.equal(code, 1);
    assert.match(cap.text(), /usage/);
  });

  it('errors (exit 1) when the name/path resolves to nothing', () => {
    const cap = capture();
    const code = overlay.lint('no-such-overlay', { homeDir: home, ...cap });
    assert.equal(code, 1);
    assert.match(cap.text(), /no overlay found/);
  });

  it('resolves a tracked overlay by NAME and lints it', () => {
    const clone = registry.clonePath('org-ov', home);
    fs.mkdirSync(clone, { recursive: true });
    writeSkill(clone, 'good', { name: 'good', description: 'ok' });
    const cap = capture();
    const code = overlay.lint('org-ov', { homeDir: home, ...cap });
    assert.equal(code, 0, cap.text());
    assert.match(cap.text(), /no issues/);
  });

  it('resolves a PATH target and exits non-zero on errors', () => {
    writeSkill(proj, 'bad', { name: 'bad', description: '' });
    const cap = capture();
    const code = overlay.lint(proj, { homeDir: home, ...cap });
    assert.equal(code, 1);
    assert.match(cap.text(), /description/);
  });

  it('--json emits a parseable result and still gates the exit code', () => {
    writeSkill(proj, 'bad', {
      name: 'bad',
      description: '',
      deploy_to: ['nope'],
    });
    const cap = capture();
    const code = overlay.lint(proj, { homeDir: home, ...cap }, { json: true });
    assert.equal(code, 1);
    const payload = JSON.parse(cap.text());
    assert.equal(payload.skillsChecked, 1);
    assert.ok(payload.findings.some((f) => f.level === 'error'));
  });
});

/**
 * No silent abstention (#508 Wave 3): linting zero skills is not a clean bill
 * of health. Advisory (D3) -- an overlay that ships only workflows is a
 * legitimate state -- so the exit stays 0 while the line stays unmissable.
 */
describe('overlay lint: zero-skill denominator', () => {
  let home, proj;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-home-'));
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-proj-'));
    fs.mkdirSync(path.join(proj, '.canary', 'skills'), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  });

  it('an empty skills dir abstains instead of reporting no issues', () => {
    const cap = capture();
    const code = overlay.lint(proj, { homeDir: home, ...cap });
    assert.equal(code, 0);
    const text = cap.text();
    assert.match(text, /Abstained/);
    assert.doesNotMatch(text, /no issues/);
    assert.doesNotMatch(text, /0 skill\(s\) — no issues/);
  });

  it('--json carries checked/abstained additively on an empty overlay', () => {
    const cap = capture();
    const code = overlay.lint(proj, { homeDir: home, ...cap }, { json: true });
    assert.equal(code, 0);
    const payload = JSON.parse(cap.text());
    assert.equal(payload.checked, 0);
    assert.equal(payload.abstained, true);
    // Existing fields unchanged.
    assert.equal(payload.skillsChecked, 0);
    assert.deepEqual(payload.findings, []);
  });

  it('an error finding outranks abstention: a missing skills dir still exits 1', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-bare-'));
    try {
      const cap = capture();
      const code = overlay.lint(bare, { homeDir: home, ...cap });
      assert.equal(code, 1);
      assert.match(cap.text(), /no \.canary\/skills directory/);
      assert.doesNotMatch(cap.text(), /Abstained/);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it('a real skill still reports the clean pass with its denominator', () => {
    writeSkill(proj, 'good', { name: 'good', description: 'ok' });
    const cap = capture();
    const code = overlay.lint(proj, { homeDir: home, ...cap });
    assert.equal(code, 0);
    assert.match(cap.text(), /no issues/);
    assert.doesNotMatch(cap.text(), /Abstained/);
  });
});
