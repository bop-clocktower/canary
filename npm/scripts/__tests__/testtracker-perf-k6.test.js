/**
 * `canary testtracker push-perf` (#1580): the pure k6 handleSummary mapping.
 * The command itself is tested in testtracker-perf-cli.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const k6 = require('../../dist/reporters/ingest/k6-summary.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'k6', 'read-slo.json');
const fixture = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

// --- the statistic a threshold judges ----------------------------------------

// Held equal to the threshold grammar TestTracker parses on its side: the
// server derives the stat it trends on with that grammar, and push-perf
// picks values[stat] with this one.
test('thresholdStat reads every k6 aggregation the server parses', () => {
  const cases = {
    'p(99)<500': 'p(99)',
    'p( 99.9 ) <= 1e3': 'p(99.9)',
    'P(95)<200': 'p(95)',
    'avg<100': 'avg',
    'min>0': 'min',
    'max<2000': 'max',
    'med<120': 'med',
    'count>10': 'count',
    'rate<0.01': 'rate',
    'value==1': 'value',
    'rate !== 0': null, // `!==` is not k6 grammar
    'p(99)<500 && avg<100': null,
    'percentile(99)<500': null,
    '': null,
  };
  for (const [expr, want] of Object.entries(cases)) {
    assert.equal(k6.thresholdStat(expr), want, expr);
  }
});

// --- reading the file ---------------------------------------------------------

const os = require('node:os');
const tempJson = (value) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-k6-'));
  const file = path.join(dir, 'summary.json');
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
};

test('readK6Summary returns the data and the file mtime', () => {
  const { summary, mtime } = k6.readK6Summary(FIXTURE);
  assert.equal(Object.keys(summary.metrics).length, 88);
  assert.ok(mtime instanceof Date);
});

test('readK6Summary refuses what is not handleSummary data', () => {
  const refused = [
    [path.join(os.tmpdir(), 'nope-k6.json'), /cannot read/],
    [tempJson('{not json'), /not JSON/],
    [tempJson({ root_group: {} }), /no "metrics"/],
    [tempJson({ metrics: [] }), /no "metrics"/],
    // --summary-export: values flattened onto the metric, thresholds as booleans
    [tempJson({ metrics: { http_reqs: { count: 3, rate: 1, thresholds: { 'count>1': false } } } }), /--summary-export/],
    [tempJson({ metrics: { m: { values: {}, thresholds: { 'avg<1': { ok: 'yes' } } } } }), /boolean "ok"/],
  ];
  for (const [file, why] of refused) {
    assert.throws(() => k6.readK6Summary(file), (e) => e instanceof k6.K6SummaryError && why.test(e.message), file);
  }
});

test('an empty metrics object is readable: abstaining on it is the command\'s call', () => {
  assert.deepEqual(k6.readK6Summary(tempJson({ metrics: {} })).summary.metrics, {});
});

// --- objectives ------------------------------------------------------------------

test('SC13: a real nightly run maps to one objective per threshold', () => {
  const objectives = k6.k6Objectives(fixture());
  assert.equal(objectives.length, 105);
  assert.equal(new Set(objectives.map((o) => o.submetric)).size, 70);
  const duration = objectives.filter((o) => o.submetric.startsWith('http_req_duration{name:'));
  const errors = objectives.filter((o) => o.submetric.startsWith('dag_errors{name:'));
  assert.equal(duration.length, 70);
  assert.equal(errors.length, 35);
  for (const o of duration) assert.match(o.expression, /^p\((50|99)\)<\d+$/);
  for (const o of errors) assert.match(o.expression, /^rate<[\d.]+$/);
  assert.equal(objectives.filter((o) => o.ok).length, 70);
  assert.equal(objectives.filter((o) => o.observedValue === null).length, 0);
  // Nothing derived is sent: TestTracker owns scenario, stat and comparator.
  for (const o of objectives) assert.deepEqual(Object.keys(o).sort(), ['expression', 'observedValue', 'ok', 'submetric']);
});

test('observedValue is values[stat] of that sub-metric', () => {
  const data = fixture();
  const sub = Object.keys(data.metrics).find((k) => k.startsWith('http_req_duration{name:'));
  const p99 = k6.k6Objectives(data).find((o) => o.submetric === sub && o.expression.startsWith('p(99)'));
  assert.equal(p99.observedValue, data.metrics[sub].values['p(99)']);
});

test('a statistic k6 did not report, a non-finite one, an unparseable expression, and an unsampled rate or trend are unmeasured', () => {
  const data = {
    metrics: {
      'http_req_duration{name:a}': { type: 'trend', values: { 'p(95)': 120 }, thresholds: { 'p(99)<500': { ok: true } } },
      'http_req_duration{name:b}': { type: 'trend', values: { avg: null }, thresholds: { 'avg<100': { ok: true } } },
      'http_req_duration{name:c}': { type: 'trend', values: { avg: 50 }, thresholds: { 'avg<100 && max<900': { ok: true } } },
      'http_req_duration{name:f}': { type: 'trend', values: { min: 0, max: 0, 'p(99)': 0 }, thresholds: { 'p(99)<500': { ok: true } } },
      'errors{name:d}': { type: 'rate', values: { rate: 0, passes: 0, fails: 0 }, thresholds: { 'rate<0.01': { ok: true } } },
      'errors{name:e}': { type: 'rate', values: { rate: 0, passes: 0, fails: 12 }, thresholds: { 'rate<0.01': { ok: true } } },
    },
  };
  const byName = Object.fromEntries(k6.k6Objectives(data).map((o) => [o.submetric, o.observedValue]));
  assert.deepEqual(byName, {
    'errors{name:d}': null,
    'errors{name:e}': 0,
    'http_req_duration{name:a}': null,
    'http_req_duration{name:b}': null,
    'http_req_duration{name:c}': null,
    'http_req_duration{name:f}': null,
  });
});

// Measured with k6 v2.2.0: a Trend sub-metric whose tag matched no request
// (one iteration, two real requests, none tagged `never-tagged`). k6 fills
// every summaryTrendStats key with 0 and judges the threshold ok, so without
// the min/max rule a route that never ran would read as a met latency
// objective. Both shapes are k6's own output, copied verbatim.
test('k6 v2.2.0 output for a never-sampled Trend and Rate is unmeasured, not met', () => {
  const data = {
    metrics: {
      // default summaryTrendStats: p(99) is not reported at all
      'http_req_duration{name:never-tagged}': {
        contains: 'time',
        values: { avg: 0, min: 0, med: 0, max: 0, 'p(90)': 0, 'p(95)': 0 },
        thresholds: { 'p(95)<500': { ok: true }, 'p(99)<500': { ok: true } },
        type: 'trend',
      },
      // summaryTrendStats including p(99): reported, as 0
      'http_req_duration{name:never-tagged-p99}': {
        type: 'trend',
        contains: 'time',
        values: { avg: 0, min: 0, med: 0, max: 0, 'p(95)': 0, 'p(99)': 0 },
        thresholds: { 'p(99)<500': { ok: true } },
      },
      'never_added{name:never-tagged}': {
        type: 'rate',
        contains: 'default',
        values: { rate: 0, passes: 0, fails: 0 },
        thresholds: { 'rate<0.01': { ok: true } },
      },
    },
  };
  const objectives = k6.k6Objectives(data);
  assert.equal(objectives.length, 4);
  for (const o of objectives) assert.equal(o.observedValue, null, `${o.submetric} ${o.expression}`);
});

test('objectives come out sorted by sub-metric, then expression', () => {
  const subs = k6.k6Objectives(fixture()).map((o) => `${o.submetric} ${o.expression}`);
  assert.deepEqual(subs, [...subs].sort());
});

// --- headline and abstention -----------------------------------------------------

test('the headline comes from http_reqs, iterations, http_req_duration and state', () => {
  assert.deepEqual(k6.k6Headline(fixture()), {
    httpReqs: 2812,
    httpReqRate: 16.260912115073914,
    iterations: 76,
    durationMs: 172930,
    p95Ms: 136.03723559999997,
    p99Ms: 359.18521202999807,
  });
});

test('an absent measurement is null, never 0', () => {
  assert.deepEqual(k6.k6Headline({ metrics: { iterations: { values: { count: 4 } } } }), {
    httpReqs: null,
    httpReqRate: null,
    iterations: 4,
    durationMs: null,
    p95Ms: null,
    p99Ms: null,
  });
});

test('abstains on no metrics, and on zero requests and zero iterations (null counts as 0)', () => {
  const reason = (data) => k6.k6Abstention(data, k6.k6Headline(data));
  assert.match(reason({ metrics: {} }), /no metrics/);
  assert.match(reason({ metrics: { checks: { values: { rate: 1 } } } }), /0 requests and 0 iterations/);
  assert.match(reason({ metrics: { http_reqs: { values: { count: 0 } }, iterations: { values: { count: 0 } } } }), /0 requests/);
  assert.equal(reason({ metrics: { iterations: { values: { count: 1 } } } }), null);
  assert.equal(reason(fixture()), null);
});
