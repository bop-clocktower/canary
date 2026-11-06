/**
 * `overlay:<name>:fresh` fetch age (#1324): a zero-behind count is only as
 * fresh as the last fetch, so doctor warns when that fetch is older than 7
 * days or was never recorded. Every case pins the clock -- never wall time.
 */
const { it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkOverlays } = require('../../dist/engine-checks.js');
const registry = require('../../dist/overlays-registry.js');

const NOW = new Date('2026-10-05T12:00:00Z');
const NAME = 'example-overlay';

let home;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-fetch-age-'));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

/** Register one overlay clone (optionally pinned) and return its path. */
function register(ref = null) {
  const clone = registry.clonePath(NAME, home);
  fs.mkdirSync(clone, { recursive: true });
  registry.write(
    registry.add(registry.emptyRegistry(), {
      name: NAME,
      source: `github:example-org/${NAME}`,
      ref,
      path: clone,
      addedDate: '2026-07-17',
      consent: null,
    }),
    home,
  );
  return clone;
}

/** Record a fetch at `iso` the way git does: FETCH_HEAD, mtime = fetch time. */
function fetchedAt(clone, iso) {
  fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
  const fetchHead = path.join(clone, '.git', 'FETCH_HEAD');
  fs.writeFileSync(fetchHead, '');
  const t = new Date(iso);
  fs.utimesSync(fetchHead, t, t);
}

/** A git stub: `behind` commits behind upstream, or no upstream at all. */
const gitStub =
  ({ behind = '0', upstream = true } = {}) =>
  (args) =>
    args[0] === 'rev-list'
      ? upstream
        ? { status: 0, stdout: behind, stderr: '' }
        : { status: 128, stdout: '', stderr: 'no upstream' }
      : { status: 0, stdout: '', stderr: '' };

/** The `:fresh` result of one checkOverlays run at the pinned NOW. */
const fresh = (git = gitStub()) =>
  checkOverlays({ homeDir: home, git, now: () => NOW }).find(
    (r) => r.id === `overlay:${NAME}:fresh`,
  );

it('warns when the last fetch is older than 7 days, naming the time, threshold, and fix', () => {
  const clone = register();
  fetchedAt(clone, '2026-09-21T12:00:00Z'); // 14 days before NOW
  const r = fresh();
  assert.equal(r.status, 'warn');
  assert.match(r.label, /2026-09-21T12:00:00Z/);
  assert.match(r.label, /7-day threshold/);
  assert.match(r.remedy, /canary overlay update example-overlay/);
  assert.ok(r.remedy.includes(`git -C ${clone} fetch`), r.remedy);
});

it('warns when no fetch was ever recorded', () => {
  register(); // no .git/FETCH_HEAD, no clone reflog
  const r = fresh();
  assert.equal(r.status, 'warn');
  assert.match(r.label, /unknown \(never fetched\)/);
  assert.match(r.label, /7-day threshold/);
  assert.match(r.remedy, /canary overlay update example-overlay/);
});

it('passes a clone fetched within 7 days', () => {
  fetchedAt(register(), '2026-10-02T12:00:00Z'); // 3 days before NOW
  const r = fresh();
  assert.equal(r.status, 'pass');
  assert.match(r.label, /up to date as of 2026-10-02T12:00:00Z/);
});

it('passes at exactly 7 days (the threshold is "older than", not "at")', () => {
  fetchedAt(register(), '2026-09-28T12:00:00Z');
  assert.equal(fresh().status, 'pass');
});

it('a stale clone that is also behind still fails (fail outranks warn)', () => {
  fetchedAt(register(), '2026-09-01T12:00:00Z');
  assert.equal(fresh(gitStub({ behind: '2' })).status, 'fail');
});

it('a pinned overlay keeps its pass, however old its last fetch', () => {
  register('v1.0.0'); // and no fetch on record at all
  const r = fresh(gitStub({ upstream: false }));
  assert.equal(r.status, 'pass');
  assert.match(r.label, /pinned @ v1\.0\.0/);
});
