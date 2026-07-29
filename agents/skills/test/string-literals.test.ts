// Unit suite for the shared string-literal range helper (#493).
//
// The helper exists twice -- canary-blackhawk and canary-savant each carry an
// identical copy, because skills are self-contained by contract (see the
// packaging suites) and #479 tracks extracting shared skill infrastructure.
// The suite runs against BOTH copies via describe.each, and a parity test
// pins them byte-identical so they cannot drift until #479 lands.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as blackhawkCopy from '../claude-code/canary-blackhawk/scripts/string-literals.mjs';
import * as savantCopy from '../claude-code/canary-savant/scripts/string-literals.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COPY_PATHS = [
  path.join(
    HERE,
    '..',
    'claude-code',
    'canary-blackhawk',
    'scripts',
    'string-literals.mjs',
  ),
  path.join(
    HERE,
    '..',
    'claude-code',
    'canary-savant',
    'scripts',
    'string-literals.mjs',
  ),
];

describe('the two copies are byte-identical (drift guard until #479)', () => {
  it('blackhawk and savant carry the same file', () => {
    const [a, b] = COPY_PATHS.map((p) => fs.readFileSync(p, 'utf8'));
    expect(a).toBe(b);
  });
});

describe.each([
  ['canary-blackhawk copy', blackhawkCopy],
  ['canary-savant copy', savantCopy],
])('%s', (_name, mod) => {
  const { stringLiteralRanges, inStringLiteral, execOutsideStrings } = mod as {
    stringLiteralRanges: (line: string) => Array<[number, number]>;
    inStringLiteral: (ranges: Array<[number, number]>, i: number) => boolean;
    execOutsideStrings: (
      pattern: RegExp,
      line: string,
      ranges: Array<[number, number]>,
    ) => RegExpExecArray | null;
  };

  const ranges = (line: string) => stringLiteralRanges(line);
  const inStr = (line: string, i: number) =>
    inStringLiteral(stringLiteralRanges(line), i);

  describe('stringLiteralRanges', () => {
    it('returns no ranges for a quote-free line', () => {
      expect(ranges('await new Promise((r) => setTimeout(r, 5))')).toEqual([]);
    });

    it('marks single-quoted content', () => {
      // pyFile('time.sleep(1)') -- content is indices 8..21
      const line = "pyFile('time.sleep(1)')";
      expect(ranges(line)).toEqual([[8, 21]]);
      expect(inStr(line, line.indexOf('time.sleep'))).toBe(true);
    });

    it('marks double-quoted content', () => {
      const line = '["assert d.strftime(1)", x]';
      expect(inStr(line, line.indexOf('strftime'))).toBe(true);
      expect(inStr(line, line.indexOf('x]'))).toBe(false);
    });

    it('an anchor before the quotes is not in the string', () => {
      const line = "d.strftime('%Y %Z')";
      expect(inStr(line, line.indexOf('strftime'))).toBe(false);
      expect(inStr(line, line.indexOf('%Z'))).toBe(true);
    });

    it('respects backslash escapes (an escaped quote does not close)', () => {
      const line = "const s = 'it\\'s late'; f(x);";
      expect(inStr(line, line.indexOf('s late'))).toBe(true);
      expect(inStr(line, line.indexOf('f(x)'))).toBe(false);
    });

    it('a quote of the other kind inside a string is literal content', () => {
      const line = 'const s = "don\'t"; g(y);';
      expect(inStr(line, line.indexOf('t"'))).toBe(true);
      expect(inStr(line, line.indexOf('g(y)'))).toBe(false);
    });

    it('marks backtick template content', () => {
      const line = 'const s = `time.sleep(1)`;';
      expect(inStr(line, line.indexOf('time.sleep'))).toBe(true);
    });

    it('treats ${...} interpolation regions as code, not string', () => {
      const line = 'const t = `now: ${Date.now()}`;';
      expect(inStr(line, line.indexOf('Date.now'))).toBe(false);
      expect(inStr(line, line.indexOf('now:'))).toBe(true);
    });

    it('handles nested braces inside an interpolation', () => {
      const line = 'const t = `v: ${fn({ a: 1 })} end`;';
      expect(inStr(line, line.indexOf('fn('))).toBe(false);
      expect(inStr(line, line.indexOf('end'))).toBe(true);
    });

    it('handles a nested template inside an interpolation', () => {
      const line = 'const t = `a${`b${Date.now()}c`}d`;';
      expect(inStr(line, line.indexOf('b$'))).toBe(true);
      expect(inStr(line, line.indexOf('Date.now'))).toBe(false);
      expect(inStr(line, line.indexOf('c`'))).toBe(true);
      expect(inStr(line, line.indexOf('d`'))).toBe(true);
    });

    it('a quoted string inside an interpolation is a string', () => {
      const line = "const t = `k: ${get('time.sleep(1)')}`;";
      expect(inStr(line, line.indexOf('time.sleep'))).toBe(true);
      expect(inStr(line, line.indexOf('get('))).toBe(false);
    });

    it('treats the rest of the line as string after an unterminated quote', () => {
      // Common with multi-line Python strings: the opener's line ends mid-string.
      const line = 'x = "leading text time.sleep(1)';
      expect(inStr(line, line.indexOf('time.sleep'))).toBe(true);
    });

    it('a trailing backslash at end of line stays unterminated', () => {
      const line = "x = 'abc\\";
      expect(inStr(line, line.indexOf('abc'))).toBe(true);
    });

    it('an unterminated interpolation region stays code', () => {
      const line = 'const t = `a${Date.now()';
      expect(inStr(line, line.indexOf('Date.now'))).toBe(false);
    });

    it('emits no range for an empty string literal', () => {
      expect(ranges('f(\'\') + g("")')).toEqual([]);
    });

    it('triple-quoted openers mark the inner content (empty pair + string)', () => {
      // """time.sleep(1)""" scans as "" + "time.sleep(1)" + "" -- good enough
      // to keep the anchor out of code.
      const line = 'x = """time.sleep(1)"""';
      expect(inStr(line, line.indexOf('time.sleep'))).toBe(true);
    });

    it('stray closing brace outside any template is ignored', () => {
      const line = "} else { f('x') }";
      expect(inStr(line, line.indexOf('x'))).toBe(true);
      expect(inStr(line, line.indexOf('else'))).toBe(false);
    });
  });

  describe('inStringLiteral', () => {
    it('is start-inclusive, end-exclusive', () => {
      expect(inStringLiteral([[3, 7]], 2)).toBe(false);
      expect(inStringLiteral([[3, 7]], 3)).toBe(true);
      expect(inStringLiteral([[3, 7]], 6)).toBe(true);
      expect(inStringLiteral([[3, 7]], 7)).toBe(false);
    });

    it('handles multiple ranges', () => {
      expect(
        inStringLiteral(
          [
            [1, 2],
            [5, 9],
          ],
          6,
        ),
      ).toBe(true);
      expect(
        inStringLiteral(
          [
            [1, 2],
            [5, 9],
          ],
          3,
        ),
      ).toBe(false);
    });
  });

  describe('execOutsideStrings', () => {
    it('returns the first match when the line has no strings', () => {
      const m = execOutsideStrings(
        /\bDate\.now\s*\(/,
        'const t = Date.now();',
        [],
      );
      expect(m).not.toBeNull();
      expect(m!.index).toBe(10);
    });

    it('rejects a match whose start index is inside a string', () => {
      const line = "const s = 'Date.now()';";
      const m = execOutsideStrings(
        /\bDate\.now\s*\(/,
        line,
        stringLiteralRanges(line),
      );
      expect(m).toBeNull();
    });

    it('retries past an in-string match to find a later code match', () => {
      const line = "const s = 'Date.now()'; const t = Date.now();";
      const m = execOutsideStrings(
        /\bDate\.now\s*\(/,
        line,
        stringLiteralRanges(line),
      );
      expect(m).not.toBeNull();
      expect(m!.index).toBe(line.lastIndexOf('Date.now'));
    });

    it('preserves named groups and input on the returned match', () => {
      const line = 'time.sleep(2)';
      const m = execOutsideStrings(
        /\btime\.sleep\s*\(\s*(?<delay>[0-9]+)\s*\)/,
        line,
        [],
      );
      expect(m!.groups?.delay).toBe('2');
      expect(m!.input).toBe(line);
    });

    it('advances past a zero-width in-string match without spinning', () => {
      // (?<=x) is zero-width; inside 'xx' it matches at index 2 which is in
      // the string, forcing the manual lastIndex bump.
      const line = "'xx'y";
      const m = execOutsideStrings(/(?<=x)/, line, stringLiteralRanges(line));
      expect(m).not.toBeNull();
      expect(m!.index).toBe(3);
    });

    it('returns null when nothing matches at all', () => {
      expect(execOutsideStrings(/\bnope\b/, 'const a = 1;', [])).toBeNull();
    });
  });
});
