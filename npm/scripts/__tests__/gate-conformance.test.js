/**
 * Gate-abstention conformance suite -- npm layer (#508, no-silent-abstention
 * D5).
 *
 * The engine registry lives in `ts/test/gate-conformance.test.ts` and the skill
 * registry in `agents/skills/test/`; this file is the npm half. It cannot live
 * with the engine rows: those run under vitest against ESM engine sources and
 * cannot invoke this package's CommonJS `runDoctor` / `overlay.lint`.
 *
 * The ROWS table IS the registry. Every npm command swept onto the gate-result
 * helper gets a row whose fixture collapses its denominator to zero and whose
 * expectation proves the loud outcome. A new npm gate is not done until it has
 * a row here.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runDoctor } = require('../../dist/doctor.js');
const overlay = require('../../dist/overlay-commands.js');
const { EXIT_ABSTAINED } = require('../../dist/gate-result.js');

function capture() {
  const chunks = [];
  const sink = { write: (s) => (chunks.push(s), true) };
  return { out: sink, err: sink, text: () => chunks.join('') };
}

/** Hermetic doctor deps: no real home, no network, deterministic git. */
const doctorDeps = (cap, over) => ({
  homeDir: os.tmpdir(),
  cwd: os.tmpdir(),
  getLatestVersion: async () => null,
  git: () => ({ status: 0, stdout: 'git version test', stderr: '' }),
  out: cap.out,
  ...over,
});

const ROWS = [
  {
    command: 'doctor (every check skipped)',
    layer: 'npm',
    kind: 'gate',
    expect: 'exit3',
    // #505: the defect that started the doctrine. Permanent negative fixture.
    forbid: ['All checks passed'],
    run: async () => {
      const cap = capture();
      const code = await runDoctor(
        [],
        doctorDeps(cap, {
          runEngineChecks: async () => [
            { id: 'a', status: 'skip', label: 'a', remedy: 'no consent' },
            { id: 'b', status: 'skip', label: 'b' },
          ],
        }),
      );
      return { code, stdout: cap.text() };
    },
  },
  {
    command: 'doctor (no check registered at all)',
    layer: 'npm',
    kind: 'gate',
    expect: 'exit3',
    forbid: ['All checks passed'],
    run: async () => {
      const cap = capture();
      const code = await runDoctor(
        [],
        doctorDeps(cap, { runEngineChecks: async () => [] }),
      );
      return { code, stdout: cap.text() };
    },
  },
  {
    command: 'overlay lint (zero skills)',
    layer: 'npm',
    kind: 'advisory',
    expect: 'warnLine',
    forbid: ['no issues'],
    run: async (base) => {
      const dir = path.join(base, 'overlay');
      fs.mkdirSync(path.join(dir, '.canary', 'skills'), { recursive: true });
      const cap = capture();
      const code = overlay.lint(dir, {
        homeDir: path.join(base, 'home'),
        out: cap.out,
        err: cap.err,
      });
      return { code, stdout: cap.text() };
    },
  },
];

describe('gate conformance registry -- npm layer (#508)', () => {
  for (const row of ROWS) {
    it(`${row.command} [${row.layer}/${row.kind}] is loud on a zero denominator`, async () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-conf-'));
      try {
        const res = await row.run(base);
        assert.match(res.stdout.toLowerCase(), /abstained/, res.stdout);
        for (const text of row.forbid) {
          assert.ok(
            !res.stdout.includes(text),
            `forbidden success copy present: ${text}\n${res.stdout}`,
          );
        }
        assert.equal(
          res.code,
          row.expect === 'exit3' ? EXIT_ABSTAINED : 0,
          res.stdout,
        );
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    });
  }
});
