/**
 * `canary testtracker push --quarantine-ledger <path>` (#1321): a skipped
 * result backed by a katana ledger row is published as quarantined, with its
 * ticket, inside the existing ingest contract (tags). Shared harness:
 * ./testtracker-harness.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { fixture, push, row } = require('./testtracker-harness.js');

const FILE = 'tests/cart/math.test.ts';
const SKIPPED = `${FILE} > math > skipped one`;
const PASSED = `${FILE} > math > adds`;

/** A katana ledger (schema v2) written to a temp file. */
function ledger(entries, raw) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-ledger-'));
  const file = path.join(dir, 'quarantine.json');
  fs.writeFileSync(
    file,
    raw ?? JSON.stringify({ schema_version: 2, entries }, null, 2),
  );
  return file;
}

const entry = (fields) => ({ kind: 'skipped', file: FILE, ...fields });
const quarantineTags = (r) =>
  r.tags.filter((t) => t === 'quarantined' || t.startsWith('quarantine:'));
const pushWith = (file) =>
  push([fixture('vitest.xml')], ['--quarantine-ledger', file]);

test('a skipped result with a ledger row is tagged quarantined with its ticket', async () => {
  const { code, payload } = await pushWith(
    ledger([entry({ test: 'skipped one', issue: '#123' })]),
  );
  assert.equal(code, 0);
  assert.deepEqual(quarantineTags(row(payload, SKIPPED)), [
    'quarantined',
    'quarantine:#123',
  ]);
  assert.equal(row(payload, SKIPPED).status, 'skipped');
});

test('a skip with no ledger row is not published as a quarantine', async () => {
  const { payload } = await pushWith(
    ledger([entry({ test: 'some other test', issue: '#9' })]),
  );
  assert.deepEqual(quarantineTags(row(payload, SKIPPED)), []);
});

test('matching needs the file too: same title in another file is not a match', async () => {
  const { payload } = await pushWith(
    ledger([
      entry({ test: 'skipped one', file: 'tests/other.test.ts', issue: '#1' }),
    ]),
  );
  assert.deepEqual(quarantineTags(row(payload, SKIPPED)), []);
});

test('a ledger row whose test ran is not tagged and is reported unmatched', async () => {
  const { code, out, payload } = await pushWith(
    ledger([entry({ test: 'adds', issue: '#5' })]),
  );
  assert.equal(code, 0);
  assert.deepEqual(quarantineTags(row(payload, PASSED)), []);
  assert.match(out, /1 ledger row matched no skipped result/);
  assert.match(out, /tests\/cart\/math\.test\.ts › adds/);
});

test('unmatched rows are counted and named; removed rows are counted, not listed', async () => {
  const { out } = await pushWith(
    ledger([
      entry({ test: 'skipped one', issue: '#123' }),
      entry({ test: 'gone missing', issue: '#7' }),
      entry({ test: 'also gone', file: 'tests/x.test.ts' }),
      entry({ test: 'deleted test', kind: 'removed' }),
    ]),
  );
  assert.match(out, /quarantine: 1 skipped result tagged from 4 ledger rows/);
  assert.match(out, /2 ledger rows matched no skipped result/);
  assert.match(out, /tests\/cart\/math\.test\.ts › gone missing/);
  assert.match(out, /tests\/x\.test\.ts › also gone/);
  assert.match(out, /1 removed row has no test to match/);
  assert.doesNotMatch(out, /deleted test/);
});

test('a v1 ledger row (`ticket`) publishes its ticket through katana load()', async () => {
  const { payload } = await pushWith(
    ledger(undefined, JSON.stringify({ entries: [entry({ test: 'skipped one', ticket: 'PROJ-42' })] })),
  );
  assert.deepEqual(quarantineTags(row(payload, SKIPPED)), [
    'quarantined',
    'quarantine:PROJ-42',
  ]);
});

test('a row with no issue sends `quarantined` alone, never an empty ticket', async () => {
  const { payload } = await pushWith(ledger([entry({ test: 'skipped one' })]));
  assert.deepEqual(quarantineTags(row(payload, SKIPPED)), ['quarantined']);
});

test('release is implicit: once the row is removed, no quarantine tag is sent', async () => {
  const file = ledger([entry({ test: 'skipped one', issue: '#123' })]);
  const before = await pushWith(file);
  assert.equal(quarantineTags(row(before.payload, SKIPPED)).length, 2);
  fs.writeFileSync(file, JSON.stringify({ schema_version: 2, entries: [] }));
  const after = await pushWith(file);
  assert.deepEqual(quarantineTags(row(after.payload, SKIPPED)), []);
});

test('without the flag nothing is tagged and no quarantine line is printed', async () => {
  const { out, payload } = await push([fixture('vitest.xml')]);
  assert.deepEqual(quarantineTags(row(payload, SKIPPED)), []);
  assert.doesNotMatch(out, /quarantine:/);
});

test('a missing ledger is loud: exit 1, nothing pushed', async () => {
  const missing = path.join(os.tmpdir(), 'no-such-dir-1321', 'quarantine.json');
  const { code, err, pushes } = await pushWith(missing);
  assert.equal(code, 1);
  assert.equal(pushes.length, 0);
  assert.match(err, /quarantine ledger .*not found/);
  assert.match(err, /Nothing was pushed/);
});

test('a corrupt ledger is loud: exit 1, nothing pushed', async () => {
  const { code, err, pushes } = await pushWith(ledger(undefined, '{not json'));
  assert.equal(code, 1);
  assert.equal(pushes.length, 0);
  assert.match(err, /ledger is not valid JSON/);
});

test('--quarantine-ledger needs a value', async () => {
  const { code, err } = await push(
    [fixture('vitest.xml')],
    ['--quarantine-ledger'],
  );
  assert.equal(code, 2);
  assert.match(err, /--quarantine-ledger needs a value/);
});
