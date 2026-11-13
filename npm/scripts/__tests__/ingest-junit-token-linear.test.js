/**
 * Tokenizing a JUnit report in linear time (#1541, CWE-1333).
 *
 * Each start of an unterminated tag, comment, CDATA section or processing
 * instruction used to scan to the end of the input before failing, so a run
 * of them cost O(n^2). The regex runs synchronously, so each size finishes in
 * seconds on the unfixed regex and fails the budget, rather than hanging.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { readJunitCases } = require(
  path.join(__dirname, '..', '..', 'dist', 'reporters', 'ingest', 'junit.js'),
);

const BUDGET_MS = 1000;

for (const [label, body] of [
  ['unclosed tags', '<a '.repeat(60_000)],
  ['unclosed double-quoted attributes', '<a "'.repeat(40_000)],
  ['unclosed single-quoted attributes', "<a '".repeat(40_000)],
  ['one unclosed long tag name', `<${'a'.repeat(100_000)}`],
  ['unclosed comments', '<!--'.repeat(100_000)],
  ['unclosed CDATA sections', '<![CDATA['.repeat(100_000)],
  ['unclosed processing instructions', '<?'.repeat(250_000)],
]) {
  test(`reads a run of ${label} within budget`, () => {
    const start = performance.now();
    readJunitCases(`<testsuites>${body}`);
    const elapsed = performance.now() - start;
    assert.ok(elapsed < BUDGET_MS, `took ${elapsed.toFixed(0)} ms`);
  });
}

test('reads an attribute value holding < and > as one tag', () => {
  const { cases } = readJunitCases(
    '<testsuites><testcase name="a">' +
      '<failure message="1 &lt; 2 > 0, raw < too"/></testcase></testsuites>',
  );
  assert.equal(cases.length, 1);
  assert.equal(cases[0].status, 'failed');
  assert.equal(cases[0].error_message, '1 < 2 > 0, raw < too');
});
