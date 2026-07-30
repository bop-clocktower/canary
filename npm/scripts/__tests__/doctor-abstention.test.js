'use strict';

// No silent abstention (#508, closes the #505 aggregation half): "skipped"
// never aggregates into "All checks passed.", and a doctor run that verified
// zero checks abstains loudly (exit 3) instead of passing.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runDoctor, summarizeChecks } = require('../../dist/doctor.js');
const registry = require('../../dist/overlays-registry.js');

const check = (status, id = `c-${status}`) => ({
  id,
  status,
  label: `${id} label`,
});

describe('summarizeChecks (#508 summary policy)', () => {
  it('all-pass keeps the classic line and exit 0', () => {
    const s = summarizeChecks([check('pass'), check('pass')]);
    assert.equal(s.line, 'All checks passed.');
    assert.equal(s.exitCode, 0);
    assert.equal(s.checked, 2);
    assert.equal(s.abstained, false);
  });

  it('skips never aggregate into "All checks passed."', () => {
    const s = summarizeChecks([check('pass'), check('skip'), check('skip')]);
    assert.equal(s.line, '1 check(s) passed (2 skipped).');
    assert.equal(s.exitCode, 0);
    assert.equal(s.checked, 1);
    assert.equal(s.skipped, 2);
  });

  it('zero verified checks is a loud abstention: exit 3, not a pass', () => {
    const s = summarizeChecks([check('skip'), check('skip'), check('info')]);
    assert.equal(s.abstained, true);
    assert.equal(s.exitCode, 3);
    assert.match(s.line, /abstained:/);
    assert.doesNotMatch(s.line, /All checks passed/);
  });

  it('an empty result set also abstains (denominator zero)', () => {
    const s = summarizeChecks([]);
    assert.equal(s.abstained, true);
    assert.equal(s.exitCode, 3);
  });

  it('failures win over abstention and skips', () => {
    const s = summarizeChecks([check('fail'), check('skip')]);
    assert.equal(s.line, '1 check(s) failed.');
    assert.equal(s.exitCode, 1);
    assert.equal(s.abstained, false);
  });
});

describe('runDoctor with consent-skipped overlay checks (#505)', () => {
  let home;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-doctor-abst-'));
    // One overlay whose only command check is consent-gated (no consent
    // recorded → the check is skipped) plus a passing file check.
    const clone = path.join(home, '.canary', 'overlays', 'acme-overlay');
    fs.mkdirSync(path.join(clone, '.canary'), { recursive: true });
    fs.writeFileSync(path.join(clone, 'present.txt'), 'x');
    fs.writeFileSync(
      path.join(clone, '.canary', 'doctor.json'),
      JSON.stringify({
        checks: [
          {
            id: 'file-ok',
            type: 'file-exists',
            path: 'present.txt',
            remedy: 'add it',
          },
          {
            id: 'cmd-gated',
            type: 'command-succeeds',
            command: ['definitely-not-a-real-binary'],
            remedy: 'install it',
          },
        ],
      }),
    );
    registry.write(
      {
        schemaVersion: 1,
        overlays: [
          {
            name: 'acme-overlay',
            source: 'github:acme/overlay',
            ref: null,
            path: clone,
            addedDate: '2026-01-01',
            consent: null,
            consentCommandsHash: null,
          },
        ],
      },
      home,
    );
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const deps = (out) => ({
    homeDir: home,
    cwd: home,
    out,
    getLatestVersion: async () => null,
    git: () => ({ status: 0, stdout: 'git version test', stderr: '' }),
  });

  it('human summary reports the skip count, never a bare all-pass', async () => {
    const chunks = [];
    const out = { write: (s) => (chunks.push(s), true) };
    const code = await runDoctor([], deps(out));
    const text = chunks.join('');
    assert.ok(!text.includes('All checks passed.'), text);
    if (code === 0) {
      assert.match(text, /check\(s\) passed \(\d+ skipped\)\./);
    }
    assert.match(text, /- cmd-gated/); // the skip stays visible per-check
  });

  it('--json carries the denominator: checked, skipped, abstained', async () => {
    const chunks = [];
    const out = { write: (s) => (chunks.push(s), true) };
    const code = await runDoctor(['--json'], deps(out));
    const payload = JSON.parse(chunks.join(''));
    assert.equal(typeof payload.checked, 'number');
    assert.ok(payload.checked > 0, 'engine checks were verified');
    assert.ok(payload.skipped >= 1, 'the consent-gated check is skipped');
    assert.equal(payload.abstained, false);
    // The one shared harness field stays consistent with the exit code.
    assert.equal(payload.allPassed, code === 0);
  });
});
