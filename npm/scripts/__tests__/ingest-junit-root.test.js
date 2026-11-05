/**
 * Recognising a JUnit report's root element (CWE-1333).
 *
 * The prolog scan has to stay linear on a document that never reaches a root,
 * and has to end each prolog item at its first terminator. The regex runs
 * synchronously, so the timed cases use a size that finishes in seconds on the
 * unfixed regex and fails the assertion, rather than one that would hang.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { isJunitXml } = require(
  path.join(__dirname, '..', '..', 'dist', 'reporters', 'ingest', 'junit.js'),
);

const BUDGET_MS = 1000;
const MIB = 1024 * 1024;
const BOM = '﻿';

const ITEMS = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<??>',
  '<?a?b?>',
  '<?a ? > b?>',
  '<?a???>',
  '<!---->',
  '<!-- a - b -->',
  '<!-- a -- b --->',
  '<!--->-->',
  '<!-- <testsuite> -->',
  '<!DOCTYPE testsuites>',
  '<!DOCTYPE testsuites SYSTEM "a?b--c">',
];

for (const [label, item, repeats] of [
  ['processing instructions', '<?a?>', 30],
  ['comments', '<!--a-->', 30],
]) {
  test(`refuses a run of ${label} that reaches no root, in linear time`, () => {
    const start = performance.now();
    const found = isJunitXml(`${item.repeat(repeats)}!`);
    const elapsed = performance.now() - start;
    assert.equal(found, false);
    assert.ok(elapsed < BUDGET_MS, `took ${elapsed.toFixed(0)} ms`);
  });
}

test('reads the root past each valid prolog item', () => {
  for (const item of ITEMS) {
    const label = JSON.stringify(item);
    assert.equal(isJunitXml(`${item}<testsuite>`), true, label);
    assert.equal(isJunitXml(`\n ${item}\n<testsuites name="s">`), true, label);
    assert.equal(isJunitXml(`${item}<testsuite/>`), true, label);
  }
});

test('reads the root past every ordered pair of prolog items', () => {
  for (const first of ITEMS) {
    for (const second of ITEMS) {
      const text = `${first}\n${second}\n<testsuite>`;
      assert.equal(isJunitXml(text), true, JSON.stringify(text));
    }
  }
});

test('keeps the leading byte order mark', () => {
  assert.equal(isJunitXml(`${BOM}<testsuites>`), true);
  assert.equal(isJunitXml(`${BOM}\n<?xml version="1.0"?><testsuite>`), true);
  assert.equal(isJunitXml(`${BOM}<root>`), false);
});

// A loop stepping through an item's body one character at a time overflows the
// engine's backtrack stack with a RangeError at about this size.
for (const [label, unit] of [
  ['ordinary text', 'a'],
  ['the terminator characters', '-?'],
]) {
  test(`reads the root past a 16 MiB item of ${label}`, () => {
    const body = unit.repeat((16 * MIB) / unit.length);
    assert.equal(isJunitXml(`<!-- ${body} --><testsuite>`), true);
    assert.equal(isJunitXml(`<?a ${body} ?><testsuite>`), true);
    assert.equal(isJunitXml(`<!-- ${body}`), false);
    assert.equal(isJunitXml(`<?a ${body}`), false);
  });
}

test('reads the root past a long run of items', () => {
  const prolog = '<?a?><!--b-->\n'.repeat(20000);
  assert.equal(isJunitXml(`${prolog}<testsuite>`), true);
});

test('ends a prolog item at its first terminator', () => {
  for (const text of [
    '<?a?><root><?b?><testsuite>',
    '<!--a--><root><!--b--><testsuite>',
    '<?a?> stray ?><testsuite>',
    '<!--a--> stray --><testsuite>',
    // The doctype item ends at its first `>`, so an internal subset was only
    // ever accepted when a declaration could stretch over it to a later item.
    '<?xml version="1.0"?><!DOCTYPE t [<!ENTITY a "b">]><?p?><testsuite>',
  ]) {
    assert.equal(isJunitXml(text), false, JSON.stringify(text));
  }
});

test('refuses unterminated items and other roots', () => {
  for (const text of [
    '<!--- <testsuite>',
    '<!---><testsuite>',
    '<?a <testsuite>',
    '<!DOCTYPE <testsuite',
    '<testsuitesx>',
    '<root><testsuite>',
  ]) {
    assert.equal(isJunitXml(text), false, JSON.stringify(text));
  }
});
