/**
 * Tokenizing a JUnit report in linear time (#1541, CWE-1333).
 *
 * Each start of an unterminated tag, comment or CDATA section used to scan to
 * the end of the input before failing, so a run of them cost O(n^2). The PI
 * case passes the CLI's well-formedness check, so `canary history record`
 * reaches it. The regex runs synchronously, so a vitest timeout cannot
 * interrupt it: each size finishes in seconds on the unfixed regex and fails
 * the budget, rather than hanging the suite.
 */

import { describe, expect, it } from 'vitest';

import { readJunitReport } from '../src/history/formats/junit-report.js';
import { isWellFormedXml } from '../src/util/xml.js';

const BUDGET_MS = 1000;
const ctx = { suite: 's', repo: 'r', branch: 'b', commitSha: 'c', nowMs: 0 };

const elapsedMs = (xml: string): number => {
  const start = performance.now();
  readJunitReport(xml, ctx);
  return performance.now() - start;
};

describe('JUnit tokenizer stays linear on unterminated markup', () => {
  it.each([
    ['unclosed tags', '<a '.repeat(60_000)],
    ['unclosed double-quoted attributes', '<a "'.repeat(40_000)],
    ['unclosed single-quoted attributes', "<a '".repeat(40_000)],
    ['one unclosed long tag name', `<${'a'.repeat(100_000)}`],
    ['unclosed comments', '<!--'.repeat(100_000)],
    ['unclosed CDATA sections', '<![CDATA['.repeat(100_000)],
  ])('reads a run of %s within budget', (_label, body) => {
    expect(elapsedMs(`<testsuites>${body}`)).toBeLessThan(BUDGET_MS);
  });

  it('reads a well-formed report hiding tags in a PI within budget', () => {
    const xml = `<testsuites><?x ${'<a '.repeat(60_000)}' ?></testsuites>`;
    expect(isWellFormedXml(xml)).toBe(true);
    expect(elapsedMs(xml)).toBeLessThan(BUDGET_MS);
  });
});

describe('JUnit tokenizer keeps well-formed tokens', () => {
  it('reads an attribute value holding < and > as one tag', () => {
    const xml =
      '<testsuites><testcase name="a" classname="k">' +
      '<failure message="1 &lt; 2 > 0, raw < too"/></testcase></testsuites>';
    const { results } = readJunitReport(xml, ctx);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      test_name: 'k::a',
      status: 'failed',
      error_text: '1 < 2 > 0, raw < too',
    });
  });
});
