/**
 * Tests for the XML primitives the Cobertura reader stands on.
 *
 * `isWellFormedXml` is a hand-rolled scanner, written precisely so that no
 * third-party parser sits inside the guardian's security boundary. That makes
 * its *rejection* paths the interesting half: if it accepts input a real
 * parser would refuse, the guardian reads a malformed coverage report as if it
 * were sound and reports a confident coverage number about nothing. Every
 * "not well formed" branch below was previously unexercised.
 *
 * The assertions are about accept/reject decisions on specific malformed
 * inputs, not about the function merely running.
 */

import { describe, expect, it } from 'vitest';

import {
  attrValue,
  isWellFormedXml,
} from '../src/guardian/diff-coverage/formats/xml.js';

describe('isWellFormedXml', () => {
  describe('well-formed input it must accept', () => {
    it('accepts balanced, self-closing, and nested elements', () => {
      expect(isWellFormedXml('<a></a>')).toBe(true);
      expect(isWellFormedXml('<a/>')).toBe(true);
      expect(isWellFormedXml('<a><b/></a>')).toBe(true);
    });

    it('accepts quoted attributes in either quote style', () => {
      expect(isWellFormedXml('<a b="c"/>')).toBe(true);
      expect(isWellFormedXml("<a b='c'/>")).toBe(true);
      expect(isWellFormedXml('<a b="" c="d"/>')).toBe(true);
    });

    it('accepts text content and valid entity references', () => {
      expect(isWellFormedXml('<a>text</a>')).toBe(true);
      expect(isWellFormedXml('<a>&amp;</a>')).toBe(true);
      expect(isWellFormedXml('<a>&#38;</a>')).toBe(true);
      expect(isWellFormedXml('<a>&#x26;</a>')).toBe(true);
    });

    it('skips comments, CDATA, and processing instructions', () => {
      expect(isWellFormedXml('<!--c--><a/>')).toBe(true);
      expect(isWellFormedXml('<a><![CDATA[ <not/> & raw ]]></a>')).toBe(true);
      expect(isWellFormedXml('<?xml version="1.0"?><a/>')).toBe(true);
    });

    it('skips a DOCTYPE, including one with an internal subset', () => {
      expect(isWellFormedXml('<!DOCTYPE a><a/>')).toBe(true);
      // The `>` inside `[ ... ]` must not be mistaken for the end of the
      // declaration, or everything after it is scanned as element content.
      expect(
        isWellFormedXml('<!DOCTYPE a [ <!ELEMENT a (#PCDATA)> ]><a/>'),
      ).toBe(true);
    });

    it('accepts an empty document', () => {
      expect(isWellFormedXml('')).toBe(true);
    });
  });

  describe('structural violations it must reject', () => {
    it('rejects an unclosed element', () => {
      expect(isWellFormedXml('<a>')).toBe(false);
      expect(isWellFormedXml('<a><b></a>')).toBe(false);
    });

    it('rejects a mismatched end tag', () => {
      expect(isWellFormedXml('<a></b>')).toBe(false);
    });

    it('rejects an end tag with nothing open', () => {
      expect(isWellFormedXml('</a>')).toBe(false);
    });

    it('rejects a malformed end tag', () => {
      expect(isWellFormedXml('<a></>')).toBe(false);
      expect(isWellFormedXml('<a></a')).toBe(false);
    });

    it('rejects a start tag that never closes', () => {
      expect(isWellFormedXml('<a')).toBe(false);
      expect(isWellFormedXml('<a b="c"')).toBe(false);
    });

    it('rejects an invalid element name', () => {
      expect(isWellFormedXml('<1a/>')).toBe(false);
    });
  });

  describe('attribute violations it must reject', () => {
    it('rejects an unquoted attribute value', () => {
      // The classic hand-rolled-scanner miss: `b=c` is not well formed XML.
      expect(isWellFormedXml('<a b=c/>')).toBe(false);
    });

    it('rejects a valueless attribute', () => {
      expect(isWellFormedXml('<a b/>')).toBe(false);
    });

    it('rejects an attribute value whose quote is never closed', () => {
      expect(isWellFormedXml('<a b="c/>')).toBe(false);
    });
  });

  describe('entity and markup violations it must reject', () => {
    it('rejects a raw ampersand', () => {
      expect(isWellFormedXml('<a>a & b</a>')).toBe(false);
    });

    it('rejects an unterminated entity reference', () => {
      expect(isWellFormedXml('<a>&amp</a>')).toBe(false);
    });

    it('rejects an unterminated comment, CDATA, or PI', () => {
      expect(isWellFormedXml('<!--c')).toBe(false);
      expect(isWellFormedXml('<![CDATA[ x')).toBe(false);
      expect(isWellFormedXml('<?xml')).toBe(false);
    });

    it('rejects an unterminated declaration', () => {
      expect(isWellFormedXml('<!DOCTYPE a')).toBe(false);
      // An internal subset that is never closed leaves the scanner inside the
      // bracket depth, so the declaration never ends.
      expect(isWellFormedXml('<!DOCTYPE a [ <!ELEMENT a> ')).toBe(false);
    });
  });
});

describe('attrValue', () => {
  it('extracts a double-quoted value', () => {
    expect(attrValue('line-rate="0.5" branch-rate="1"', 'line-rate')).toBe(
      '0.5',
    );
  });

  it('extracts a single-quoted value', () => {
    expect(attrValue("name='pkg'", 'name')).toBe('pkg');
  });

  it('returns an empty string for a present but empty attribute', () => {
    // Distinct from absence: the caller can tell "declared empty" from "not
    // declared" only if these do not collapse to the same answer.
    expect(attrValue('name=""', 'name')).toBe('');
  });

  it('returns null when the attribute is absent', () => {
    expect(attrValue('name="pkg"', 'missing')).toBeNull();
  });

  it('tolerates whitespace around the equals sign', () => {
    expect(attrValue('name =  "pkg"', 'name')).toBe('pkg');
  });

  it('reads each attribute the Cobertura reader actually asks for', () => {
    // The three live call sites (cobertura.ts) request exactly these names.
    // Pinned together because a `<line>` tag carries several attributes and
    // picking the wrong one yields a plausible-looking but wrong coverage row.
    const line = 'number="12" hits="3" branch="true"';
    expect(attrValue(line, 'number')).toBe('12');
    expect(attrValue(line, 'hits')).toBe('3');
    expect(attrValue('name="C" filename="src/a.ts"', 'filename')).toBe(
      'src/a.ts',
    );
  });

  // NOTE (latent, deliberately not asserted): the name is interpolated into a
  // `\b`-anchored RegExp, and `\b` matches after a hyphen -- so asking for
  // `rate` against `line-rate="0.5"` returns "0.5" rather than null. No
  // current caller hits this (they ask for filename/number/hits, and no
  // Cobertura attribute ends with those), so it is latent rather than a live
  // defect. It is reported for the build pipeline rather than fixed here:
  // test-fleet characterizes behavior and never edits the code under test,
  // and pinning the current answer would bake the wrong contract in.
});
