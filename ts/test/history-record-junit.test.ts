/**
 * JUnit XML for `canary history record` (#963).
 *
 * One reader covers pytest, jest-junit, surefire/Gradle and the rest. Fixtures
 * are synthetic (ts/test/fixtures/junit/); every test and class name is made up.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  buildRunFromReport,
  countReportResults,
  detectReportShape,
} from '../src/history/run-recorder.js';

const CTX = {
  suite: 'py',
  repo: 'acme/widgets',
  branch: 'main',
  commitSha: 'deadbeefcafe',
  nowMs: 1_754_000_000_000,
};

const fixture = (name: string): string =>
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'junit', name),
    'utf-8',
  );

function byName(xml: string): Map<string, Record<string, unknown>> {
  const built = buildRunFromReport('junit', xml, CTX);
  return new Map(built.results.map((r) => [r.test_name, { ...r }]));
}

describe('detectReportShape (JUnit)', () => {
  it('detects a <testsuites> root and a bare <testsuite> root', () => {
    expect(detectReportShape(fixture('pytest-style.xml'))).toBe('junit');
    expect(detectReportShape(fixture('surefire-style.xml'))).toBe('junit');
  });

  it('refuses XML whose root is not a JUnit suite', () => {
    expect(detectReportShape('<?xml version="1.0"?><coverage/>')).toBe(
      'unknown',
    );
    expect(detectReportShape('not xml at all')).toBe('unknown');
  });
});

describe('pytest-style report', () => {
  const xml = fixture('pytest-style.xml');

  it('maps failure/error/skipped/pass and classname::name', () => {
    const rows = byName(xml);
    const base = 'tests.test_basket.TestBasket::';
    expect(rows.get(`${base}test_add_item`)?.['status']).toBe('passed');
    expect(rows.get(`${base}test_remove_item`)?.['status']).toBe('failed');
    expect(rows.get(`${base}test_total`)?.['status']).toBe('failed');
    expect(rows.get('tests.test_basket::test_discount')?.['status']).toBe(
      'skipped',
    );
    expect(rows.get(`${base}test_add_item`)?.['test_file']).toBe(
      'tests/test_basket.py',
    );
  });

  it('converts fractional seconds to duration_ms and treats absent time as 0', () => {
    const rows = byName(xml);
    expect(
      rows.get('tests.test_basket.TestBasket::test_add_item')?.['duration_ms'],
    ).toBe(250);
    expect(
      rows.get('tests.test_basket.TestBasket::test_total')?.['duration_ms'],
    ).toBe(0);
    expect(rows.get('tests.test_basket::test_discount')?.['duration_ms']).toBe(
      1,
    );
  });

  it('decodes entities and CDATA in the failure text', () => {
    const err = String(
      byName(xml).get('tests.test_basket.TestBasket::test_remove_item')?.[
        'error_text'
      ],
    );
    expect(err).toContain('assert 2 == 1 & more');
    expect(err).toContain('expected <1> got <2>');
  });

  it('collapses a repeated classname+name into one flaky row when the last attempt passed', () => {
    const built = buildRunFromReport('junit', xml, CTX);
    const retried = built.results.filter(
      (r) => r.test_name === 'tests.test_basket::test_retry_me',
    );
    expect(retried).toHaveLength(1);
    expect(retried[0]?.status).toBe('flaky');
    expect(retried[0]?.duration_ms).toBe(1000);
  });

  it('counts the run from collapsed rows and takes the suite timestamp as UTC', () => {
    const built = buildRunFromReport('junit', xml, CTX);
    expect(countReportResults(xml)).toBe(5);
    expect(built.run).toMatchObject({
      total: 5,
      passed: 1,
      failed: 2,
      flaky: 1,
      skipped: 1,
      duration_ms: 1751,
      timestamp: '2026-09-01T10:00:00.000+00:00',
    });
  });
});

describe('surefire-style report', () => {
  const xml = fixture('surefire-style.xml');

  it('reads flakyFailure on a passing case as flaky', () => {
    const rows = byName(xml);
    expect(
      rows.get('com.example.widgets.GadgetTest::spinsUp')?.['status'],
    ).toBe('flaky');
  });

  it('keeps failure + rerunFailure as failed (every rerun failed)', () => {
    const rows = byName(xml);
    expect(
      rows.get('com.example.widgets.GadgetTest::spinsDown')?.['status'],
    ).toBe('failed');
  });

  it('reads rerunError without a final failure as flaky', () => {
    const rows = byName(xml);
    expect(
      rows.get('com.example.widgets.GadgetTest::restarts')?.['status'],
    ).toBe('flaky');
  });

  it('falls back to nowMs when the suite has no timestamp', () => {
    const built = buildRunFromReport('junit', xml, CTX);
    expect(built.run.timestamp).toBe(
      new Date(CTX.nowMs).toISOString().replace('Z', '+00:00'),
    );
    expect(built.run).toMatchObject({
      total: 4,
      passed: 1,
      failed: 1,
      flaky: 2,
    });
  });
});

describe('empty and nested reports', () => {
  it('counts zero testcases so record abstains', () => {
    expect(
      countReportResults('<testsuites><testsuite name="x"/></testsuites>'),
    ).toBe(0);
    expect(
      countReportResults('<testsuite name="x" tests="0"></testsuite>'),
    ).toBe(0);
  });

  it('reads testcases nested in inner testsuites', () => {
    const xml =
      '<testsuites><testsuite name="outer"><testsuite name="inner">' +
      '<testcase classname="a.B" name="c" time="1"/></testsuite></testsuite></testsuites>';
    const built = buildRunFromReport('junit', xml, CTX);
    expect(built.results.map((r) => r.test_name)).toEqual(['a.B::c']);
  });

  it('uses the bare name when classname is absent (jest-junit style)', () => {
    const xml =
      '<testsuites><testsuite><testcase name="adds &lt;two&gt;"/></testsuite></testsuites>';
    const built = buildRunFromReport('junit', xml, CTX);
    expect(built.results[0]?.test_name).toBe('adds <two>');
  });
});
