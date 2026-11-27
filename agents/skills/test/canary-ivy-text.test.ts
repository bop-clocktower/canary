/**
 * canary-ivy (#615) -- the one escaping helper every input-derived string
 * passes through before it reaches Markdown, JSON, stdout or stderr (spec D10,
 * SC10).
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_TEXT,
  md,
  plain,
} from '../claude-code/canary-ivy/scripts/text.mjs';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe('plain', () => {
  it('strips CSI colour sequences and OSC hyperlinks', () => {
    expect(plain(`${ESC}[31mred${ESC}[0m`)).toBe('red');
    expect(plain(`${ESC}]8;;http://x${BEL}link${ESC}]8;;${BEL}`)).toBe('link');
    expect(plain(`${ESC}]0;title${ESC}\\after`)).toBe('after');
    expect(plain(`a${ESC}Mb`)).toBe('ab');
  });

  it('turns newlines, control and line/bidi characters into one space', () => {
    expect(plain('a\nb\r\nc\td')).toBe('a b c d');
    expect(plain('a\u0000b\u007fc\u0085d')).toBe('a b c d');
    expect(plain('a\u2028b\u2029c')).toBe('a b c');
    expect(plain('a\u202eb\u2066c')).toBe('a b c');
    expect(plain(`left${ESC}`)).toBe('left');
  });

  it('collapses whitespace and trims', () => {
    expect(plain('   a    b   ')).toBe('a b');
  });

  it('clamps by code point with an ellipsis', () => {
    const long = 'x'.repeat(10000);
    const out = plain(long);
    expect(out.length).toBe(MAX_TEXT);
    expect(out.endsWith('...')).toBe(true);
    expect(plain('abcdef', 5)).toBe('ab...');
    // A surrogate pair is never split in half.
    const emoji = '\u{1F600}'.repeat(10);
    expect([...plain(emoji, 5)]).toHaveLength(5);
  });

  it('accepts null, undefined and numbers', () => {
    expect(plain(null)).toBe('');
    expect(plain(undefined)).toBe('');
    expect(plain(42)).toBe('42');
  });
});

describe('md', () => {
  it('escapes Markdown metacharacters so a value cannot forge a link or table cell', () => {
    expect(md('[x](http://evil)')).toBe('\\[x\\]\\(http://evil\\)');
    expect(md('a|b')).toBe('a\\|b');
    expect(md('*_`#<>~{}!+&\\')).toBe(
      '\\*\\_\\`\\#\\<\\>\\~\\{\\}\\!\\+\\&\\\\',
    );
  });

  it('applies plain first: one line, no escape byte, clamped', () => {
    const out = md(`# heading\n${ESC}[2J[link](x)` + 'y'.repeat(500));
    expect(out).not.toContain('\n');
    expect(out).not.toContain(ESC);
    expect(out.startsWith('\\# heading \\[link\\]\\(x\\)')).toBe(true);
    expect(out.endsWith('...')).toBe(true);
  });

  it('leaves dots and hyphens in paths alone', () => {
    expect(md('tests/a-b.spec.ts')).toBe('tests/a-b.spec.ts');
  });
});
