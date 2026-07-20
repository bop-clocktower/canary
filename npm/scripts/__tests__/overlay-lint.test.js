const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { lintOverlay } = require('../../dist/overlay-lint.js');

/** Write a SKILL.md under an overlay path's .canary/skills/<name>/. */
function writeSkill(overlay, name, frontmatter, extra = {}) {
  const dir = path.join(overlay, '.canary', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`)
    .join('\n');
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\n${fm}\n---\n\n# ${name}\n`,
  );
  if (extra.cliFile) {
    const p = path.join(dir, extra.cliFile);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '#!/usr/bin/env python3\n');
  }
  return dir;
}

function errors(result) {
  return result.findings.filter((f) => f.level === 'error');
}

describe('lintOverlay', () => {
  let ov;
  beforeEach(() => (ov = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-lint-'))));
  afterEach(() => fs.rmSync(ov, { recursive: true, force: true }));

  it('passes a well-formed overlay (no errors)', () => {
    writeSkill(ov, 'good', {
      name: 'good',
      description: 'Does a useful thing',
      deploy_to: ['e2e_ui', 'all'],
    });
    const r = lintOverlay(ov);
    assert.equal(r.skillsChecked, 1);
    assert.deepEqual(errors(r), []);
  });

  it('flags a missing/empty description (frontmatter floor)', () => {
    writeSkill(ov, 'nodesc', { name: 'nodesc', description: '' });
    const r = lintOverlay(ov);
    assert.ok(errors(r).some((f) => /description/.test(f.message)));
  });

  it('flags a missing name', () => {
    // name omitted entirely
    writeSkill(ov, 'noname', { description: 'has desc but no name' });
    const r = lintOverlay(ov);
    assert.ok(errors(r).some((f) => /name/.test(f.message)));
  });

  it('flags a deploy_to value that is not a known target', () => {
    writeSkill(ov, 'baddeploy', {
      name: 'baddeploy',
      description: 'x',
      deploy_to: ['e2e_ui', 'bogus_shape'],
    });
    const r = lintOverlay(ov);
    assert.ok(errors(r).some((f) => /bogus_shape/.test(f.message)));
  });

  it('accepts every known deploy_to target incl. the `all` sentinel', () => {
    writeSkill(ov, 'alltargets', {
      name: 'alltargets',
      description: 'x',
      deploy_to: [
        'api',
        'e2e_ui',
        'frontend_unit',
        'load',
        'performance',
        'all',
      ],
    });
    assert.deepEqual(errors(lintOverlay(ov)), []);
  });

  it('flags a cli: path that does not exist', () => {
    writeSkill(ov, 'deadcli', {
      name: 'deadcli',
      description: 'x',
      cli: 'scripts/missing.py',
    });
    const r = lintOverlay(ov);
    assert.ok(
      errors(r).some((f) => /cli/.test(f.message) && /missing/.test(f.message)),
    );
  });

  it('accepts a cli: path that exists', () => {
    writeSkill(
      ov,
      'livecli',
      { name: 'livecli', description: 'x', cli: 'scripts/cli.py' },
      { cliFile: 'scripts/cli.py' },
    );
    assert.deepEqual(errors(lintOverlay(ov)), []);
  });

  it('rejects a cli: path that escapes the skill dir', () => {
    writeSkill(ov, 'escape', {
      name: 'escape',
      description: 'x',
      cli: '../../../etc/passwd',
    });
    const r = lintOverlay(ov);
    assert.ok(errors(r).some((f) => /escapes/.test(f.message)));
  });

  it('flags an invalid .canary/doctor.json (reuses loadManifest)', () => {
    writeSkill(ov, 'ok', { name: 'ok', description: 'x' });
    fs.writeFileSync(path.join(ov, '.canary', 'doctor.json'), '{ not json');
    const r = lintOverlay(ov);
    assert.ok(errors(r).some((f) => /doctor\.json/.test(f.message)));
  });

  it('accepts a valid doctor.json', () => {
    writeSkill(ov, 'ok', { name: 'ok', description: 'x' });
    fs.writeFileSync(
      path.join(ov, '.canary', 'doctor.json'),
      JSON.stringify({
        checks: [{ id: 'c', type: 'file-exists', path: 'x', remedy: 'r' }],
      }),
    );
    assert.deepEqual(errors(lintOverlay(ov)), []);
  });

  it('reports an error when the overlay has no skills dir', () => {
    const r = lintOverlay(ov); // empty temp dir
    assert.ok(r.findings.some((f) => /no .canary\/skills/.test(f.message)));
  });
});
