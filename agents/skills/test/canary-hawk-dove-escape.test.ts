// canary-hawk-dove's one escaping helper (#618): every value from a ledger,
// a gate's JSON, git or a path reaches Markdown or a terminal through here.

import { describe, expect, it } from 'vitest';

import { clean, md } from '../claude-code/canary-hawk-dove/scripts/escape.mjs';

const ZWSP = '\u200b';

describe('clean', () => {
  it('strips ANSI escapes and flattens control characters', () => {
    expect(clean('a\x1b[31mred\x1b[0m')).toBe('ared');
    expect(clean('a\x1b]8;;http://x\x07b')).toBe('ab');
    expect(clean('one\ntwo\rthree\tfour')).toBe('one two three four');
    expect(clean('x\u2028y\u2029z\u0085w')).toBe('x y z w');
  });

  it('clamps by code point and never splits a surrogate pair', () => {
    const emoji = '\u{1F426}'.repeat(10);
    const out = clean(emoji, 5);
    expect(Array.from(out)).toHaveLength(5);
    expect(out.endsWith('...')).toBe(true);
    expect(out.startsWith('\u{1F426}\u{1F426}')).toBe(true);
  });

  it('renders null and undefined as empty text', () => {
    expect(clean(null)).toBe('');
    expect(clean(undefined)).toBe('');
  });
});

describe('md', () => {
  it('escapes Markdown metacharacters', () => {
    expect(md('| # * _ ` [x](y) <b> ~ ! &')).toBe(
      '\\| \\# \\* \\_ \\` \\[x\\](y) \\<b\\> \\~ \\! \\&',
    );
  });

  it('cannot forge a table row or a heading from a newline', () => {
    expect(md('a\n| forged | row |\n# h')).not.toMatch(/\n/);
  });

  it('neutralises every GFM autolink form', () => {
    expect(md('see https://evil.example/x')).toBe(
      `see https:/${ZWSP}/evil.example/x`,
    );
    expect(md('www.evil.example')).toBe(`www${ZWSP}.evil.example`);
    expect(md('mail me a@b.example')).toBe(`mail me a${ZWSP}@b.example`);
    expect(md('WWW.SHOUT.example')).toBe(`WWW${ZWSP}.SHOUT.example`);
  });

  it('clamps before escaping, so an escape is never cut in half', () => {
    const out = md('|'.repeat(50), 10);
    expect(out).toBe(`${'\\|'.repeat(7)}...`);
  });
});
