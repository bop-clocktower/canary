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
    stringLiteralRanges: (
      line: string,
      masked?: string,
    ) => Array<[number, number]>;
    inStringLiteral: (ranges: Array<[number, number]>, i: number) => boolean;
    execOutsideStrings: (
      pattern: RegExp,
      line: string,
      ranges: Array<[number, number]>,
    ) => RegExpExecArray | null;
  };

  // Braced bodies on purpose: harness's functionLength heuristic scans for
  // the first `{` after a declaration, so a concise arrow here would be
  // "measured" as running through the next describe block (#495 round 2).
  const ranges = (line: string) => {
    return stringLiteralRanges(line);
  };
  const inStr = (line: string, i: number) => {
    return inStringLiteral(stringLiteralRanges(line), i);
  };

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

  // #1188: .tsx/.jsx lines are read through a JSX-masked twin.
  describe('JSX-aware ranges', () => {
    const { maskSourceForFile, trimmedRanges } = mod as {
      maskSourceForFile: (text: string, file: string) => string;
      trimmedRanges: (raw: string, masked?: string) => Array<[number, number]>;
    };
    const SRC = "render(<p>It's</p>, label('Date.now()'));\n";

    it('returns .ts/.js/.py source itself, unmasked', () => {
      for (const file of ['a.test.ts', 'a.test.js', 'test_a.py', '<text>']) {
        expect(maskSourceForFile(SRC, file)).toBe(SRC);
      }
      expect(maskSourceForFile(SRC, 'a.test.tsx')).not.toBe(SRC);
    });

    it('is exactly stringLiteralRanges when there is no masked twin', () => {
      const line = SRC.trimEnd();
      const plain = stringLiteralRanges(line);
      expect(stringLiteralRanges(line, line)).toEqual(plain);
    });

    it('rejects JSX text and reads strings from the masked twin', () => {
      const line = SRC.trimEnd();
      const masked = maskSourceForFile(SRC, 'a.test.jsx').trimEnd();
      const r = stringLiteralRanges(line, masked);
      expect(inStringLiteral(r, line.indexOf("It's"))).toBe(true);
      expect(inStringLiteral(r, line.indexOf('Date.now'))).toBe(true);
      expect(inStringLiteral(r, line.indexOf('label'))).toBe(false);
      expect(inStringLiteral(r, line.indexOf('</p>'))).toBe(false);
    });

    it('aligns trimmedRanges to the trimmed line', () => {
      const raw = "\t  render(<p>It's {Date.now()}</p>);  ";
      const masked = maskSourceForFile(raw, 'a.test.tsx');
      const stripped = raw.trim();
      const r = trimmedRanges(raw, masked);
      expect(inStringLiteral(r, stripped.indexOf('Date.now'))).toBe(false);
      expect(inStringLiteral(r, stripped.indexOf("It's"))).toBe(true);
      expect(trimmedRanges(raw)).toEqual(stringLiteralRanges(stripped));
    });
  });

  // #1192: quotes in comments and regex literals are not delimiters.
  describe('comment- and regex-aware ranges', () => {
    const { maskSourceForFile } = mod as {
      maskSourceForFile: (text: string, file: string) => string;
    };
    const read = (line: string, file = 'a.test.ts') =>
      stringLiteralRanges(line, maskSourceForFile(line, file));
    const contentAt = (line: string, needle: string, file?: string) =>
      inStringLiteral(read(line, file), line.indexOf(needle));

    it.each([
      ["run(/* it's */ label('Date.now()'));", 'block comment'],
      ["expect(x).toMatch(/it's/); label('Date.now()');", 'regex literal'],
      ['expect(x).toMatch(/["]/); label("Date.now()");', 'regex class'],
      ["return /it's/.test(s) && label('Date.now()');", 'regex after return'],
    ])('%s: the fixture stays data (%s)', (line) => {
      expect(contentAt(line, 'Date.now')).toBe(true);
      expect(contentAt(line, 'label')).toBe(false);
    });

    it('adds no ranges of its own: comment and regex text stay code', () => {
      const line = "run(/* it's */ x, /it's/); // don't";
      expect(read(line)).toEqual([]);
    });

    it('reads `a / b / c` as division', () => {
      const line = "const r = a / b / c; label('x');";
      expect(read(line)).toEqual([
        [line.indexOf("'x'") + 1, line.indexOf("x'") + 1],
      ]);
      const half = "const h = total / 2, s = '/'; stamp(Date.now());";
      expect(contentAt(half, 'stamp')).toBe(false);
    });

    it('sees a block comment opened on an earlier line', () => {
      const text = "/* a long\n   note, it's */ label('Date.now()');";
      const masked = maskSourceForFile(text, 'a.test.ts').split('\n')[1]!;
      const line = text.split('\n')[1]!;
      const r = stringLiteralRanges(line, masked);
      expect(inStringLiteral(r, line.indexOf('Date.now'))).toBe(true);
      expect(inStringLiteral(r, line.indexOf('label'))).toBe(false);
    });

    it('keeps the length and line breaks', () => {
      const text = 'a(/* it\'s */ 1);\r\nb(/"/);\n';
      const masked = maskSourceForFile(text, 'a.test.js');
      expect(masked).toHaveLength(text.length);
      expect(masked.split(/\r\n|\n/)).toHaveLength(
        text.split(/\r\n|\n/).length,
      );
    });

    it.each(['test_a.py', 'FooTest.php', '<text>'])(
      'does not lex %s as JavaScript',
      (file) => {
        const text = "n = total // 2; label('x') /* it's */";
        expect(maskSourceForFile(text, file)).toBe(text);
      },
    );
  });
});
