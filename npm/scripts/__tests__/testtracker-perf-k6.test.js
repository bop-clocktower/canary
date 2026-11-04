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
