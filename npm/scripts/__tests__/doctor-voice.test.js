// Voice pack slice 2 (#340): `canary doctor` adds one Black Canary line under
// its summary when a check failed. ADR 0031: the --json report and the exit
// code are identical with flavor on and off, green and abstained runs stay
// unvoiced, and a missing lines file just means no line. The npm selector must
// pick the same line as the test reporter's for the same counts.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runDoctor } = require('../../dist/doctor.js');
const voice = require('../../dist/voice.js');

const REPO = path.join(__dirname, '..', '..', '..');
const ROOT_LINES = path.join(REPO, 'voice', 'lines.json');
const STAGED_LINES = path.join(
  __dirname,
  '..',
  '..',
  'dist',
  'voice',
  'lines.json',
);

function capture() {
  const chunks = [];
  return {
    out: { write: (s) => (chunks.push(s), true) },
    text: () => chunks.join(''),
  };
}

const fail = {
  id: 'git',
  label: 'git on PATH',
  status: 'fail',
  remedy: 'install git',
};
const pass = { id: 'node', label: 'node', status: 'pass' };

const deps = (results, over = {}) => ({
  homeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-voice-')),
  runEngineChecks: async () => results,
  env: {},
  voiceLinesPath: ROOT_LINES,
  ...over,
});

const allLines = () =>
  Object.values(JSON.parse(fs.readFileSync(ROOT_LINES, 'utf8'))).flatMap((m) =>
    Object.values(m).flat(),
  );

describe('canary doctor voice line', () => {
  it('a failing run ends with one attribution and one voiced line', async () => {
    const cap = capture();
    const code = await runDoctor([], deps([pass, fail], { out: cap.out }));
    assert.equal(code, 1);
    const tail = cap.text().trimEnd().split('\n').slice(-2);
    assert.match(tail[0], /^Voice: Black Canary .*CANARY_NO_FLAVOR=1/);
    assert.ok(allLines().includes(tail[1].replace(/^ {2}"|"$/g, '')), tail[1]);
  });

  it('CANARY_NO_FLAVOR=1 and --no-flavor remove it', async () => {
    for (const [args, env] of [
      [[], { CANARY_NO_FLAVOR: '1' }],
      [['--no-flavor'], {}],
    ]) {
      const cap = capture();
      await runDoctor(args, deps([fail], { out: cap.out, env }));
      assert.doesNotMatch(cap.text(), /Voice:/);
      for (const line of allLines()) assert.ok(!cap.text().includes(line));
    }
  });

  it('a green run gets no line', async () => {
    const cap = capture();
    assert.equal(await runDoctor([], deps([pass], { out: cap.out })), 0);
    assert.doesNotMatch(cap.text(), /Voice:/);
  });

  it('an abstained run (nothing verified) gets no line', async () => {
    const cap = capture();
    assert.equal(await runDoctor([], deps([], { out: cap.out })), 3);
    assert.doesNotMatch(cap.text(), /Voice:/);
  });

  it('--json and the exit code are identical with flavor on and off', async () => {
    const on = capture();
    const off = capture();
    const codeOn = await runDoctor(
      ['--json'],
      deps([pass, fail], { out: on.out }),
    );
    const codeOff = await runDoctor(
      ['--json'],
      deps([pass, fail], { out: off.out, env: { CANARY_NO_FLAVOR: '1' } }),
    );
    assert.equal(on.text(), off.text());
    assert.equal(codeOn, codeOff);
  });

  it('a missing lines file means no line and the same exit code', async () => {
    const cap = capture();
    const code = await runDoctor(
      [],
      deps([fail], {
        out: cap.out,
        voiceLinesPath: path.join(os.tmpdir(), 'nope.json'),
      }),
    );
    assert.equal(code, 1);
    assert.doesNotMatch(cap.text(), /Voice:/);
  });

  it('the npm build stages voice/lines.json byte-identically', () => {
    assert.equal(
      fs.readFileSync(STAGED_LINES, 'utf8'),
      fs.readFileSync(ROOT_LINES, 'utf8'),
    );
  });
});

describe('selector conformance with the test reporter', () => {
  it('both selectors pick the same line for the same counts', async () => {
    const reporter = await import(
      path.join(
        REPO,
        'agents',
        'skills',
        'claude-code',
        'canary-test-reporter',
        'scripts',
        'voice.mjs',
      )
    );
    const lines = { p: { m: ['a', 'b', 'c', 'd', 'e'] } };
    for (let total = 0; total < 30; total++) {
      const counts = {
        total,
        passed: total % 4,
        failed: total % 3,
        flaky: total % 2,
      };
      assert.equal(
        voice.pickLine(lines, 'p', 'm', counts),
        reporter.pickLine(lines, 'p', 'm', counts),
      );
      assert.equal(
        voice.flavorOn({ CANARY_NO_FLAVOR: String(total % 2) }, false),
        reporter.flavorOn({ CANARY_NO_FLAVOR: String(total % 2) }, false),
      );
    }
  });
});
