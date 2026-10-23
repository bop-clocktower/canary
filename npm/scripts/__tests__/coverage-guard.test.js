/**
 * Zero-file guard for the npm/ coverage run (#1444).
 *
 * `npm test` measures coverage with node's built-in `--experimental-test-coverage`
 * and floors it with `--test-coverage-lines/branches/functions`. A floor over an
 * EMPTY report is not a floor: if the include globs stop matching (a rename of
 * `dist/`, a tsc `outDir` change, a node release that reinterprets the globs),
 * node reports "all files" over nothing and the thresholds pass vacuously. The
 * guard reads the lcov file the run wrote and abstains -- exit 3, which fails
 * CI -- unless at least one `SF:` record names a file inside the package.
 *
 * Each case below is a planted positive: a report shape the guard must reject.
 */
const { describe, it, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SCRIPT = path.resolve(__dirname, '..', 'coverage-guard.mjs');
const EXIT_ABSTAINED = 3;

let main;
let dir;

function capture() {
  const chunks = [];
  return {
    sink: { write: (s) => (chunks.push(s), true) },
    text: () => chunks.join(''),
  };
}

function writeLcov(text) {
  fs.mkdirSync(path.join(dir, 'coverage'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'coverage', 'lcov.info'), text);
}

/** Run the guard in-process against the temp package root. */
function check(argv = []) {
  const cap = capture();
  const code = main(argv, { cwd: dir, out: cap.sink });
  return { code, stdout: cap.text() };
}

const record = (sf) => `TN:\nSF:${sf}\nDA:1,1\nLF:1\nLH:1\nend_of_record\n`;

before(async () => {
  ({ main } = await import(pathToFileURL(SCRIPT).href));
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-covguard-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('coverage-guard: rejects a report that covers no npm/ file', () => {
  it('abstains when coverage/lcov.info does not exist', () => {
    const res = check();
    assert.equal(res.code, EXIT_ABSTAINED, res.stdout);
    assert.match(res.stdout, /abstained/);
  });

  it('abstains on an empty lcov file', () => {
    writeLcov('');
    const res = check();
    assert.equal(res.code, EXIT_ABSTAINED, res.stdout);
    assert.match(res.stdout, /abstained: 0 npm\/ files/);
  });

  it('abstains when every SF record lies outside the package', () => {
    // The two out-of-tree shapes a real run produced before the include globs
    // were scoped: a sibling tree (`../agents/...`) and an absolute path.
    const outside = path.join(os.tmpdir(), 'not-the-package', 'x.js');
    writeLcov(record('../agents/skills/lib/is-main.mjs') + record(outside));
    const res = check();
    assert.equal(res.code, EXIT_ABSTAINED, res.stdout);
    assert.match(res.stdout, /abstained: 0 npm\/ files/);
  });
});

describe('coverage-guard: passes a report with in-package files', () => {
  it('counts relative and absolute in-package SF records, ignoring the rest', () => {
    writeLcov(
      record('dist/doctor.js') +
        record(path.join(dir, 'bin', 'canary.js')) +
        record('../ts/test/fixtures/probe.cjs'),
    );
    const res = check();
    assert.equal(res.code, 0, res.stdout);
    assert.match(res.stdout, /covers 2 npm\/ files/);
  });
});

describe('coverage-guard --reset', () => {
  it('deletes a stale report so a previous run cannot satisfy the guard', () => {
    writeLcov(record('dist/doctor.js'));
    assert.equal(check(['--reset']).code, 0);
    assert.equal(check().code, EXIT_ABSTAINED);
  });

  it('creates coverage/ so the lcov reporter has somewhere to write', () => {
    assert.equal(check(['--reset']).code, 0);
    assert.ok(fs.statSync(path.join(dir, 'coverage')).isDirectory());
  });
});

describe('coverage-guard as a script', () => {
  it('exits 3 from the CLI when run in a directory with no report', () => {
    const res = spawnSync(process.execPath, [SCRIPT], {
      cwd: dir,
      encoding: 'utf-8',
    });
    assert.equal(res.status, EXIT_ABSTAINED, res.stdout + res.stderr);
  });
});
