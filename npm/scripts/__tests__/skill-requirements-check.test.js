const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkSkillRequirements } = require('../../dist/engine-checks.js');

/** Write an overlay skill under `home` whose SKILL.md declares `requires`. */
function overlaySkill(home, overlay, skill, requires) {
  const dir = path.join(
    home,
    '.canary',
    'overlays',
    overlay,
    '.canary',
    'skills',
    skill,
  );
  fs.mkdirSync(dir, { recursive: true });
  const req = requires ? `requires: [${requires.join(', ')}]\n` : '';
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${skill}\n${req}---\n\n# ${skill}\n`,
  );
}

/** Write a local (.canary/skills) skill under `cwd`. */
function localSkill(cwd, skill, requires) {
  const dir = path.join(cwd, '.canary', 'skills', skill);
  fs.mkdirSync(dir, { recursive: true });
  const req = requires ? `requires: [${requires.join(', ')}]\n` : '';
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${skill}\n${req}---\n\n# ${skill}\n`,
  );
}

function probe(present, versions = {}) {
  return (cmd) => ({
    present: present.includes(cmd),
    version: versions[cmd] ?? null,
  });
}

describe('checkSkillRequirements (doctor engine check)', () => {
  let home, cwd;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'req-home-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'req-cwd-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('is INFO when no installed skill declares requirements', () => {
    overlaySkill(home, 'ov', 'plain', null);
    const r = checkSkillRequirements({
      homeDir: home,
      cwd,
      skillProbe: probe([]),
    });
    assert.equal(r.status, 'info');
  });

  it('passes when every declared requirement is satisfied', () => {
    overlaySkill(home, 'ov', 'runner', ['python3>=3.11', 'node']);
    const r = checkSkillRequirements({
      homeDir: home,
      cwd,
      skillProbe: probe(['python3', 'node'], { python3: '3.14.0' }),
    });
    assert.equal(r.status, 'pass');
    assert.match(r.label, /satisfied/);
  });

  it('FAILS and names the skill + command when a requirement is missing', () => {
    overlaySkill(home, 'ov', 'runner', ['python3>=3.11']);
    const r = checkSkillRequirements({
      homeDir: home,
      cwd,
      skillProbe: probe([]), // python3 absent
    });
    assert.equal(r.status, 'fail');
    assert.match(r.label, /unmet/);
    assert.match(r.remedy, /runner/);
    assert.match(r.remedy, /python3/);
  });

  it('FAILS when a present command is too old', () => {
    overlaySkill(home, 'ov', 'runner', ['python3>=3.11']);
    const r = checkSkillRequirements({
      homeDir: home,
      cwd,
      skillProbe: probe(['python3'], { python3: '3.9.7' }),
    });
    assert.equal(r.status, 'fail');
    assert.match(r.remedy, /3\.9\.7/);
  });

  it('covers local (.canary/skills) requirements too', () => {
    localSkill(cwd, 'local-runner', ['deno']);
    const r = checkSkillRequirements({
      homeDir: home,
      cwd,
      skillProbe: probe([]), // deno absent
    });
    assert.equal(r.status, 'fail');
    assert.match(r.remedy, /local\/local-runner/);
  });

  it('does not fail on a present command whose version cannot be read', () => {
    overlaySkill(home, 'ov', 'runner', ['python3>=3.11']);
    const r = checkSkillRequirements({
      homeDir: home,
      cwd,
      skillProbe: probe(['python3'], { python3: null }), // present, unknown version
    });
    assert.equal(r.status, 'pass');
  });
});
