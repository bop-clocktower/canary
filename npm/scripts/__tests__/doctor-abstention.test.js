/**
 * No-silent-abstention, npm layer (#508 Wave 3, D7).
 *
 * Doctor is instance zero of the doctrine violation (#505): it printed
 * `All checks passed.` while every check had been skipped, because it only ever
 * counted failures and never its own denominator. These tests pin the
 * denominator policy (`summarizeChecks`) and the two surfaces that render it.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { runDoctor, summarizeChecks } = require('../../dist/doctor.js');
const { EXIT_ABSTAINED } = require('../../dist/gate-result.js');

/** Capture everything runDoctor writes to `out`. */
function capture() {
  const chunks = [];
  return {
    out: { write: (s) => (chunks.push(s), true) },
    text: () => chunks.join(''),
  };
}

const group = (header, results) => ({ header, results });
const r = (id, status, over = {}) => ({ id, status, label: id, ...over });

describe('summarizeChecks (denominator policy)', () => {
  it('every check skipped -> abstained, exit 3, never a pass line', () => {
    const s = summarizeChecks([
      group('Engine', [
        r('a', 'skip', { remedy: 'no consent' }),
        r('b', 'skip'),
      ]),
    ]);
    assert.equal(s.checked, 0);
    assert.equal(s.abstained, true);
    assert.equal(s.exitCode, EXIT_ABSTAINED);
    assert.match(s.summaryLine, /Abstained/);
    assert.doesNotMatch(s.summaryLine, /passed/);
  });

  it('no checks registered at all -> abstained, not a vacuous pass', () => {
    const s = summarizeChecks([]);
    assert.equal(s.checked, 0);
    assert.equal(s.abstained, true);
    assert.equal(s.exitCode, EXIT_ABSTAINED);
  });

  it('info-only run abstains: an informational line is not a verification', () => {
    const s = summarizeChecks([group('Engine', [r('v', 'info')])]);
    assert.equal(s.checked, 0);
    assert.equal(s.abstained, true);
  });

  it('pass + skip: skips stay visible and never fold into the passed count', () => {
    const s = summarizeChecks([
      group('Engine', [r('a', 'pass'), r('b', 'pass')]),
      group('Overlay: acme', [r('c', 'skip', { remedy: 'needs consent' })]),
    ]);
    assert.equal(s.checked, 2);
    assert.equal(s.passed, 2);
    assert.equal(s.abstained, false);
    assert.equal(s.exitCode, 0);
    assert.match(s.summaryLine, /All 2 run check\(s\) passed/);
    assert.match(s.summaryLine, /1 skipped: c/);
  });

  it('a failure outranks abstention: 1 fail + 9 skips is a finding, not silence', () => {
    const skips = Array.from({ length: 9 }, (_, i) => r(`s${i}`, 'skip'));
    const s = summarizeChecks([group('Engine', [r('x', 'fail'), ...skips])]);
    assert.equal(s.checked, 1);
    assert.equal(s.failed, 1);
    assert.equal(s.abstained, false);
    assert.equal(s.exitCode, 1);
    assert.match(s.summaryLine, /1 check\(s\) failed/);
    assert.match(s.summaryLine, /9 skipped/);
  });

  it('skip reasons prefer the remedy, falling back to the label', () => {
    const s = summarizeChecks([
      group('Engine', [
        r('a', 'pass'),
        r('b', 'skip', { label: 'B label', remedy: 'B remedy' }),
      ]),
    ]);
    assert.equal(s.skipped.length, 1);
    assert.equal(s.skipped[0].name, 'b');
    assert.equal(s.skipped[0].reason, 'B remedy');
  });
});

/**
 * Hermetic doctor whose ONLY engine check outcome is forced, so the run has a
 * controlled denominator. `checks` replaces the engine check set entirely.
 */
const abstainingDeps = (over = {}) => ({
  homeDir: os.tmpdir(),
  cwd: os.tmpdir(),
  getLatestVersion: async () => null,
  git: () => ({ status: 0, stdout: 'git version test', stderr: '' }),
  ...over,
});

describe('runDoctor: human report on a collapsed denominator', () => {
  it('prints the abstention line + remediation and exits 3', async () => {
    const cap = capture();
    const code = await runDoctor([], {
      ...abstainingDeps(),
      out: cap.out,
      runEngineChecks: async () => [
        { id: 'a', status: 'skip', label: 'a', remedy: 'not applicable here' },
      ],
    });
    assert.equal(code, EXIT_ABSTAINED);
    const text = cap.text();
    assert.doesNotMatch(text, /All checks passed/);
    assert.match(text, /Abstained/);
    // Remediation is required: say why the denominator collapsed.
    assert.match(text, /skipped/i);
  });

  it('a genuine green still reads as a pass and exits 0', async () => {
    const cap = capture();
    const code = await runDoctor([], {
      ...abstainingDeps(),
      out: cap.out,
      runEngineChecks: async () => [{ id: 'a', status: 'pass', label: 'a' }],
    });
    assert.equal(code, 0);
    assert.match(cap.text(), /All 1 run check\(s\) passed/);
  });
});

describe('runDoctor --json: denominator fields', () => {
  it('carries checked/skipped/abstained; allPassed is false on abstention', async () => {
    const cap = capture();
    const code = await runDoctor(['--json'], {
      ...abstainingDeps(),
      out: cap.out,
      runEngineChecks: async () => [
        { id: 'a', status: 'skip', label: 'a', remedy: 'no consent' },
      ],
    });
    assert.equal(code, EXIT_ABSTAINED);
    const report = JSON.parse(cap.text());
    assert.equal(report.checked, 0);
    assert.equal(report.abstained, true);
    assert.equal(report.allPassed, false);
    assert.equal(report.skipped.length, 1);
    assert.equal(report.skipped[0].name, 'a');
    // Existing contract is untouched.
    assert.equal(report.version, 1);
    assert.equal(report.checks.length, 1);
  });

  it('a real green reports abstained false and allPassed true', async () => {
    const cap = capture();
    const code = await runDoctor(['--json'], {
      ...abstainingDeps(),
      out: cap.out,
      runEngineChecks: async () => [{ id: 'a', status: 'pass', label: 'a' }],
    });
    assert.equal(code, 0);
    const report = JSON.parse(cap.text());
    assert.equal(report.checked, 1);
    assert.equal(report.abstained, false);
    assert.equal(report.allPassed, true);
    assert.deepEqual(report.skipped, []);
  });
});
