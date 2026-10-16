/**
 * A `<class` inside CDATA or a processing instruction is character data, not
 * markup (#1360). The scanner used to see it as a real open tag, pair it with
 * the next real class's `</class>`, and credit that class's hits to the fake
 * filename — so a crafted `coverage.xml` could flip a file's covered/uncovered
 * verdict. A real XML reader binds these lines to the real class.
 */
import { describe, expect, it } from 'vitest';

import { parseCobertura } from '../src/guardian/diff-coverage/formats/cobertura.js';

const REAL_CLASS =
  '<class filename="b.py"><lines><line number="1" hits="2"/></lines></class>';

function doc(inner: string): string {
  return `<?xml version="1.0"?><coverage><classes>${inner}</classes></coverage>`;
}

function files(xml: string): string[] {
  return Object.keys(parseCobertura(xml) ?? {}).sort();
}

describe('Cobertura scanner skips non-markup text (#1360)', () => {
  it('a <class> inside CDATA does not capture the next class', () => {
    const xml = doc(`<![CDATA[<class filename="a.py">]]>${REAL_CLASS}`);
    expect(files(xml)).toEqual(['b.py']);
    expect(parseCobertura(xml)!['b.py']!.hits).toEqual({ 1: 2 });
  });

  it('a <class> inside a processing instruction does not capture the next class', () => {
    const xml = doc(`<?pi <class filename="a.py"> ?>${REAL_CLASS}`);
    expect(files(xml)).toEqual(['b.py']);
    expect(parseCobertura(xml)!['b.py']!.hits).toEqual({ 1: 2 });
  });

  it('a comment opener inside a processing instruction is not a comment', () => {
    // If `<!--` inside the PI were read as a comment, everything up to the
    // `-->` in the later PI would be deleted, b.py with it.
    const xml = doc(
      `<?pi <!-- ?>${REAL_CLASS}<?pi --> ?>` +
        '<class filename="c.py"><lines><line number="3" hits="0"/></lines></class>',
    );
    expect(files(xml)).toEqual(['b.py', 'c.py']);
  });

  it('a CDATA opener inside a comment is not CDATA', () => {
    const xml = doc(`<!-- <![CDATA[ -->${REAL_CLASS}<!-- ]]> -->`);
    expect(files(xml)).toEqual(['b.py']);
  });

  it('a well-formed report with a declaration and CDATA still parses', () => {
    const xml = doc(
      `<![CDATA[ just text ]]>${REAL_CLASS}` +
        '<class filename="c.py"><lines><line number="3" hits="0"/></lines></class>',
    );
    expect(files(xml)).toEqual(['b.py', 'c.py']);
    expect(parseCobertura(xml)!['c.py']!.hits).toEqual({ 3: 0 });
  });
});
