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
