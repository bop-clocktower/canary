const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { runDoctor, parseJsonFlag } = require('../../dist/doctor.js');

/** Capture everything runDoctor writes to `out`. */
function capture() {
  const chunks = [];
  return {
    out: { write: (s) => (chunks.push(s), true) },
    text: () => chunks.join(''),
  };
}

/** Hermetic deps: no real home, no network, deterministic git. */
const baseDeps = (over = {}) => ({
  homeDir: os.tmpdir(),
  cwd: os.tmpdir(),
  getLatestVersion: async () => null,
  git: () => ({ status: 0, stdout: 'git version test', stderr: '' }),
  ...over,
});

describe('parseJsonFlag', () => {
  it('detects --json', () => {
    assert.equal(parseJsonFlag(['--json']), true);
    assert.equal(parseJsonFlag(['--persona', 'x', '--json']), true);
  });
  it('is false when absent', () => {
    assert.equal(parseJsonFlag([]), false);
    assert.equal(parseJsonFlag(['--persona', 'x']), false);
  });
});

describe('doctor --json output contract', () => {
  it('emits a single parseable JSON object with version/checks/allPassed', async () => {
    const cap = capture();
    const code = await runDoctor(['--json'], baseDeps({ out: cap.out }));
    const payload = JSON.parse(cap.text());
    assert.equal(payload.version, 1);
    assert.ok(Array.isArray(payload.checks));
    assert.equal(typeof payload.allPassed, 'boolean');
    // allPassed must agree with the process exit code.
    assert.equal(payload.allPassed, code === 0);
  });

  it('each check carries the canary-owned fields id/status/label/group', async () => {
    const cap = capture();
    await runDoctor(['--json'], baseDeps({ out: cap.out }));
    const { checks } = JSON.parse(cap.text());
    assert.ok(checks.length > 0, 'engine checks should always be present');
    for (const c of checks) {
      assert.equal(typeof c.id, 'string');
      assert.ok(['pass', 'fail', 'skip', 'info'].includes(c.status), c.status);
      assert.equal(typeof c.label, 'string');
      assert.equal(typeof c.group, 'string');
    }
  });

  it('prints no human-readable header text in JSON mode', async () => {
    const cap = capture();
    await runDoctor(['--json'], baseDeps({ out: cap.out }));
    const text = cap.text();
    assert.ok(!text.includes('canary doctor'), 'no banner in JSON mode');
    assert.ok(
      !text.includes('All checks passed.'),
      'no summary line in JSON mode',
    );
  });

  it('surfaces an unknown-persona hint as a warning, not silent', async () => {
    const cap = capture();
    // No overlays installed, so any persona is unknown → hint.
    await runDoctor(
      ['--persona', 'ghost', '--json'],
      baseDeps({ out: cap.out }),
    );
    const payload = JSON.parse(cap.text());
    assert.ok(Array.isArray(payload.warnings));
    assert.ok(
      payload.warnings.some((w) => w.includes('ghost')),
      payload.warnings.join('|'),
    );
  });

  it('text mode is unchanged (still prints the banner)', async () => {
    const cap = capture();
    await runDoctor([], baseDeps({ out: cap.out }));
    assert.ok(cap.text().includes('canary doctor'));
  });
});
