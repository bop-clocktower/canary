/**
 * canary-dev-pipeline (#666) -- the one escaping module every printed value
 * goes through. Values come from git, file names and other skills' findings,
 * so none of them is trusted to be a single, plain, short line.
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_TEXT,
  clean,
  cleanDeep,
  escapeRegExp,
  md,
} from '../claude-code/canary-dev-pipeline/scripts/escape.mjs';

describe('clean', () => {
  it('strips ANSI CSI, OSC and two-byte escapes', () => {
    expect(clean('\x1b[31mred\x1b[0m')).toBe('red');
    expect(clean('a\x1b]8;;http://x\x07link\x1b]8;;\x07b')).toBe('alinkb');
    expect(clean('a\x1b]0;title\x1b\\b')).toBe('ab');
    expect(clean('a\x1bcb')).toBe('ab');
  });

  it('replaces newlines and C0/C1 controls with a space, so a value is one line', () => {
    expect(clean('a\nb\rc\td\u0000e\u007ff\u0085g\u2028h')).toBe(
      'a b c d e f g h',
    );
  });

  it('clamps long values with an ASCII ellipsis', () => {
    const long = 'x'.repeat(MAX_TEXT + 50);
    const out = clean(long);
    expect(out.length).toBe(MAX_TEXT);
    expect(out.endsWith('...')).toBe(true);
    expect(clean('abcdef', 5)).toBe('ab...');
    expect(clean('abc', 5)).toBe('abc');
  });

  it('clamps by code point, never splitting a surrogate pair', () => {
    const out = clean('\u{1F600}'.repeat(10), 5);
    expect(out).toBe('\u{1F600}\u{1F600}...');
  });

  it('renders null and undefined as empty, and stringifies the rest', () => {
    expect(clean(null)).toBe('');
    expect(clean(undefined)).toBe('');
    expect(clean(42)).toBe('42');
  });
});

describe('md', () => {
  it('escapes Markdown metacharacters after cleaning', () => {
    expect(md('a*b_c`d[e](f)<g>|h#i~j!k&l\\m')).toBe(
      'a\\*b\\_c\\`d\\[e\\](f)\\<g\\>\\|h\\#i\\~j\\!k\\&l\\\\m',
    );
  });

  it('cannot be used to inject a heading, a link or a table row', () => {
    const hostile = 'x\n# Owned\n[click](http://evil)|';
    const out = md(hostile);
    expect(out).not.toContain('\n');
    expect(out).not.toMatch(/(^|[^\\])\[/);
    expect(out).not.toMatch(/(^|[^\\])\|/);
  });

  it('clamps before escaping, so escaping never cuts a value mid-escape', () => {
    expect(md('*'.repeat(10), 6)).toBe('\\*\\*\\*...');
  });
});

describe('cleanDeep', () => {
  it('cleans every string in a JSON value and leaves other scalars alone', () => {
    const value = {
      a: 'x\x1b[1m\ny',
      b: [1, true, null, 'p\u0007q'],
      c: { d: 'ok' },
    };
    expect(cleanDeep(value)).toEqual({
      a: 'x y',
      b: [1, true, null, 'p q'],
      c: { d: 'ok' },
    });
  });

  it('cleans keys as well as values', () => {
    expect(cleanDeep({ 'k\n1': 'v' })).toEqual({ 'k 1': 'v' });
  });

  it('never lets two keys that collide after cleaning overwrite each other', () => {
    // Two file paths that differ only by a control character clean to the
    // same text. Both findings must survive; the later key gets a suffix.
    const out = cleanDeep({
      'src/a\nb.ts': 'first',
      'src/a\rb.ts': 'second',
      'src/a\tb.ts': 'third',
    }) as Record<string, string>;
    expect(Object.values(out).sort()).toEqual(['first', 'second', 'third']);
    expect(Object.keys(out)).toEqual([
      'src/a b.ts',
      'src/a b.ts~2',
      'src/a b.ts~3',
    ]);
  });

  it('never collides a suffixed key with a real key of the same text', () => {
    const out = cleanDeep({
      'k\n': 1,
      'k ~2': 2,
      'k\r': 3,
    }) as Record<string, number>;
    expect(Object.values(out).sort()).toEqual([1, 2, 3]);
    expect(new Set(Object.keys(out)).size).toBe(3);
  });

  it('clamps keys at the JSON limit, not the display limit', () => {
    const a = `${'x'.repeat(MAX_TEXT + 10)}A`;
    const b = `${'x'.repeat(MAX_TEXT + 10)}B`;
    const out = cleanDeep({ [a]: 1, [b]: 2 }) as Record<string, number>;
    expect(Object.keys(out)).toEqual([a, b]);
  });
});

describe('escapeRegExp', () => {
  it('escapes every regex metacharacter so the text matches only itself', () => {
    const text = 'a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o/p-q';
    const re = new RegExp(`^${escapeRegExp(text)}$`);
    expect(re.test(text)).toBe(true);
    expect(re.test('aXb*c+d?e^f$g{h}i(j)k|l[m]n\\o/p-q')).toBe(false);
  });
});
