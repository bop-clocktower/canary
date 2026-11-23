/**
 * `canary testtracker push --level <level> --features-map <file>`: the suite
 * says what it is. Each test's file is matched against a glob → feature-slug
 * map (first match wins, like the area map) and the run carries the suite's
 * level, so a dashboard can place every result on a feature × level matrix
 * without keeping its own copy of the mapping.
 *
 * The distinction pinned throughout: an unmatched test sends NO `features` key
 * (the suite said nothing), while a glob mapped to `[]` sends `features: []`
 * (the suite says it covers no feature). Collapsing the two would make a
 * dashboard treat silence as an answer.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PUSH_ENV, fixture, push, row } = require('./testtracker-harness.js');
const { reporterModule } = require('./ingest-harness.js');

const MATH_ADDS = 'tests/cart/math.test.ts > math > adds';

function mapFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-features-'));
  const file = path.join(dir, 'features.json');
  fs.writeFileSync(
    file,
    typeof contents === 'string' ? contents : JSON.stringify(contents),
  );
  return file;
}

const titleOf = (payload, pattern) =>
  payload.results.find((r) => pattern.test(r.full_title))?.full_title;

test('--level is sent as the run level; without it the key is absent', async () => {
  const on = await push([fixture('vitest.xml')], ['--level', 'unit']);
  assert.equal(on.code, 0);
  assert.equal(on.payload.level, 'unit');
  const off = await push([fixture('vitest.xml')]);
  assert.equal('level' in off.payload, false);
});

test('CANARY_INGEST_LEVEL sets the level, and --level wins over it', async () => {
  const env = { ...PUSH_ENV, CANARY_INGEST_LEVEL: 'integration' };
  const fromEnv = await push([fixture('vitest.xml')], [], { env });
  assert.equal(fromEnv.payload.level, 'integration');
  const flag = await push([fixture('vitest.xml')], ['--level', 'contract'], {
    env,
  });
  assert.equal(flag.payload.level, 'contract');
});

test("--features-map puts the first matching glob's slugs on each result and its catalog entry", async () => {
  const file = mapFile({
    'tests/cart/**': ['cart', 'checkout'],
    'tests/**': ['everything-else'],
  });
  const { code, payload } = await push(
    [fixture('vitest.xml')],
    ['--features-map', file],
  );
  assert.equal(code, 0);
  const title = titleOf(payload, /adds/);
  assert.deepEqual(row(payload, title).features, ['cart', 'checkout']);
  const listed = payload.collected.find((c) => c.full_title === title);
  assert.deepEqual(listed.features, ['cart', 'checkout']);
});

test('a test no glob matches sends no features key at all: silence is not "covers none"', async () => {
  const file = mapFile({ 'src/billing/**': ['billing'] });
  const { payload } = await push(
    [fixture('vitest.xml')],
    ['--features-map', file],
  );
  for (const r of payload.results)
    assert.equal('features' in r, false, r.full_title);
  for (const c of payload.collected)
    assert.equal('features' in c, false, c.full_title);
});

test('a glob mapped to [] sends features: [] — the suite saying the test covers no feature', async () => {
  const file = mapFile({ 'tests/**': [] });
  const { payload } = await push(
    [fixture('vitest.xml')],
    ['--features-map', file],
  );
  assert.deepEqual(row(payload, titleOf(payload, /adds/)).features, []);
});

test('a bare string value is one slug', async () => {
  const file = mapFile({ 'tests/cart/**': 'cart' });
  const { payload } = await push(
    [fixture('vitest.xml')],
    ['--features-map', file],
  );
  assert.deepEqual(row(payload, titleOf(payload, /adds/)).features, ['cart']);
});

test('CANARY_INGEST_FEATURE_MAP is read when no --features-map is given', async () => {
  const env = {
    ...PUSH_ENV,
    CANARY_INGEST_FEATURE_MAP: JSON.stringify({ 'tests/cart/**': ['cart'] }),
  };
  const { payload } = await push([fixture('vitest.xml')], [], { env });
  assert.deepEqual(row(payload, titleOf(payload, /adds/)).features, ['cart']);
});

for (const [label, file, pattern] of [
  [
    'a missing --features-map file',
    path.join(os.tmpdir(), 'no-such-features.json'),
    /could not read --features-map/,
  ],
  [
    'a --features-map that is not JSON',
    mapFile('{not json'),
    /feature map must be a JSON object/,
  ],
  [
    'a --features-map with a non-string slug',
    mapFile({ 'tests/**': [1] }),
    /feature map must be a JSON object/,
  ],
]) {
  test(`${label} exits 1 with nothing pushed`, async () => {
    const { code, pushes, err } = await push(
      [fixture('vitest.xml')],
      ['--features-map', file],
    );
    assert.equal(code, 1);
    assert.equal(pushes.length, 0);
    assert.match(err, pattern);
    assert.match(err, /Nothing was pushed/);
  });
}

test('resolveFeatures: feature annotations win over the map, deduplicated', () => {
  const { resolveFeatures } = reporterModule;
  const map = { 'tests/**': ['mapped'] };
  assert.deepEqual(
    resolveFeatures(
      [
        { type: 'feature', description: 'a' },
        { type: 'feature', description: 'a' },
        { type: 'feature', description: 'b' },
      ],
      'tests/x.spec.ts',
      map,
    ),
    ['a', 'b'],
  );
  assert.deepEqual(resolveFeatures([], 'tests/x.spec.ts', map), ['mapped']);
  assert.equal(resolveFeatures([], 'src/x.ts', map), undefined);
});

test('a title merged across reports covers what either copy said', () => {
  const { dedupeByFullTitle } = reporterModule;
  const base = {
    full_title: MATH_ADDS,
    test_file: 'f',
    status: 'passed',
    retries: 0,
    tags: [],
  };
  const [merged] = dedupeByFullTitle([
    { ...base, features: ['a'] },
    { ...base, features: ['b', 'a'] },
  ]);
  assert.deepEqual(merged.features, ['a', 'b']);
  const [neither] = dedupeByFullTitle([{ ...base }, { ...base }]);
  assert.equal('features' in neither, false);
});
