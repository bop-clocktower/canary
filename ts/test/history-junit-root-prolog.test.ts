/**
 * Recognising a JUnit report's root element (CWE-1333).
 *
 * The prolog scan has to stay linear on a document that never reaches a root,
 * and has to end each prolog item at its first terminator. The regex runs
 * synchronously, so a vitest timeout cannot interrupt it: the timed cases use a
 * size that finishes in seconds on the unfixed regex and fails the assertion,
 * rather than one that would hang the suite.
 */

import { describe, expect, it } from 'vitest';

import { detectReportShape } from '../src/history/run-recorder.js';

const SHAPE_BUDGET_MS = 1000;
const MIB = 1024 * 1024;

const shapeOf = (text: string) => detectReportShape(text);

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

describe('JUnit root detection stays linear', () => {
  it.each([
    ['processing instructions', '<?a?>', 30],
    ['comments', '<!--a-->', 30],
  ])('refuses a run of %s that reaches no root', (_label, item, repeats) => {
    const start = performance.now();
    const shape = shapeOf(`${item.repeat(repeats)}!`);
    const elapsed = performance.now() - start;
    expect(shape).toBe('unknown');
    expect(elapsed).toBeLessThan(SHAPE_BUDGET_MS);
  });
});

describe('JUnit root detection on a valid prolog', () => {
  it.each(ITEMS)('reads the root past %s', (item) => {
    expect(shapeOf(`${item}<testsuite>`)).toBe('junit');
    expect(shapeOf(`\n ${item}\n<testsuites name="s">`)).toBe('junit');
    expect(shapeOf(`${item}<testsuite/>`)).toBe('junit');
  });

  it('reads the root past every ordered pair of prolog items', () => {
    for (const first of ITEMS) {
      for (const second of ITEMS) {
        expect(shapeOf(`${first}\n${second}\n<testsuite>`)).toBe('junit');
      }
    }
  });

  it('reads a bare root with no prolog', () => {
    expect(shapeOf('<testsuites>')).toBe('junit');
    expect(shapeOf('  <testsuite\nname="s">')).toBe('junit');
  });

  // A loop stepping through an item's body one character at a time overflows
  // the engine's backtrack stack with a RangeError at about this size.
  it.each([
    ['ordinary text', 'a'],
    ['the terminator characters', '-?'],
  ])('reads the root past a 16 MiB item of %s', (_label, unit) => {
    const body = unit.repeat((16 * MIB) / unit.length);
    expect(shapeOf(`<!-- ${body} --><testsuite>`)).toBe('junit');
    expect(shapeOf(`<?a ${body} ?><testsuite>`)).toBe('junit');
    expect(shapeOf(`<!-- ${body}`)).toBe('unknown');
    expect(shapeOf(`<?a ${body}`)).toBe('unknown');
  });

  it('reads the root past a long run of items', () => {
    expect(shapeOf(`${'<?a?><!--b-->\n'.repeat(20000)}<testsuite>`)).toBe(
      'junit',
    );
  });
});

describe('JUnit root detection ends an item at its first terminator', () => {
  it.each([
    ['a non-JUnit root after a declaration', '<?a?><root><?b?><testsuite>'],
    ['a non-JUnit root after a comment', '<!--a--><root><!--b--><testsuite>'],
    ['text after a processing instruction', '<?a?> stray ?><testsuite>'],
    ['text after a comment', '<!--a--> stray --><testsuite>'],
    // The doctype item ends at its first `>`, so an internal subset was only
    // ever accepted when a declaration could stretch over it to a later item.
    [
      'an internal doctype subset',
      '<?xml version="1.0"?><!DOCTYPE t [<!ENTITY a "b">]><?p?><testsuite>',
    ],
  ])('does not span %s', (_label, text) => {
    expect(shapeOf(text)).toBe('unknown');
  });

  it.each([
    ['an unterminated comment', '<!--- <testsuite>'],
    ['the near-terminator of a comment', '<!---><testsuite>'],
    ['an unterminated processing instruction', '<?a <testsuite>'],
    ['an unterminated doctype', '<!DOCTYPE <testsuite'],
    ['a different root name', '<testsuitesx>'],
    ['an unprefixed non-JUnit root', '<root><testsuite>'],
  ])('refuses %s', (_label, text) => {
    expect(shapeOf(text)).toBe('unknown');
  });
});
