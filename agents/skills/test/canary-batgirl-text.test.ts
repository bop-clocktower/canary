/**
 * canary-batgirl's escaping helper and bounded reads (#619, spec D9, D10).
 *
 * Every value that reaches batgirl's output came from a file a branch controls:
 * a path, a parse error quoting file content, a branch name. `plain` makes it
 * one inert line; `md` additionally makes it inert Markdown. The bounded reads
 * are what keep a hostile input from making any later scan large: an input
 * over a limit is reported as not read, never truncated into a partial value.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_TEXT,
  md,
  plain,
} from '../claude-code/canary-batgirl/scripts/text.mjs';
import {
  LIMITS,
  overEntries,
  readJson,
  readJsonFiles,
  readText,
} from '../claude-code/canary-batgirl/scripts/read.mjs';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'batgirl-text-'));
  dirs.push(d);
  return d;
}

const ESC = '\u001b';

describe('plain', () => {
  it('strips ANSI CSI and OSC sequences', () => {
    expect(plain(`${ESC}[31mred${ESC}[0m`)).toBe('red');
    expect(plain(`${ESC}]8;;http://x${ESC}\\link`)).toBe('link');
  });

  it('turns control characters and line breaks into one line', () => {
    const out = plain('a\nb\r\nc\u0000d\u2028e\u202ef');
    expect(out).toBe('a b c d e f');
    expect(out).not.toMatch(/[\u0000-\u001f\u2028\u202e]/);
  });

  it('clamps to the limit in code points', () => {
    const out = plain('x'.repeat(MAX_TEXT + 50));
    expect([...out].length).toBe(MAX_TEXT);
    expect(out.endsWith('...')).toBe(true);
    expect(plain('abcdef', 4)).toBe('a...');
  });

  it('renders null and undefined as empty', () => {
    expect(plain(null)).toBe('');
    expect(plain(undefined)).toBe('');
  });
});

describe('md', () => {
  it('escapes every Markdown metacharacter batgirl prints mid-line', () => {
    const out = md('a|b*c_d`e[f](g)#h<i>!j~k{l}&m\\n+o');
    for (const ch of '|*_`[]()#<>!~{}&+') {
      expect(out).toContain(`\\${ch}`);
    }
  });

  it('escapes after flattening, so an injected line cannot start a heading', () => {
    expect(md('ok\n# Injected')).toBe('ok \\# Injected');
  });
});

describe('readText', () => {
  it('reports a missing file as missing', () => {
    expect(readText(path.join(tmp(), 'nope.json')).kind).toBe('missing');
  });

  it('reports a directory where a file was expected as unreadable', () => {
    const r = readText(tmp());
    expect(r.kind).toBe('unreadable');
  });

  it('does not read a file over the byte limit', () => {
    const f = path.join(tmp(), 'big.json');
    fs.writeFileSync(f, 'x'.repeat(64));
    const r = readText(f, { ...LIMITS, bytes: 16 });
    expect(r).toEqual({
      kind: 'not-read',
      reason: 'not read: 64 bytes is over the 16-byte limit',
    });
  });

  it('reads a file within the limit', () => {
    const f = path.join(tmp(), 'ok.txt');
    fs.writeFileSync(f, 'hello');
    expect(readText(f)).toEqual({ kind: 'ok', value: 'hello' });
  });
});

describe('readJson', () => {
  it('parses JSON', () => {
    const f = path.join(tmp(), 'a.json');
    fs.writeFileSync(f, '{"a": 1}');
    expect(readJson(f)).toEqual({ kind: 'ok', value: { a: 1 } });
  });

  it('reports unparseable JSON as invalid, with the parser message', () => {
    const f = path.join(tmp(), 'a.json');
    fs.writeFileSync(f, '{not json');
    const r = readJson(f);
    expect(r.kind).toBe('invalid');
    expect(r.reason).toMatch(/^not valid JSON: /);
  });

  it('passes a not-read result through without parsing', () => {
    const f = path.join(tmp(), 'a.json');
    fs.writeFileSync(f, '{"a": 1}');
    expect(readJson(f, { ...LIMITS, bytes: 2 }).kind).toBe('not-read');
  });
});

describe('readJsonFiles', () => {
  it('reads one file as a one-element list', () => {
    const f = path.join(tmp(), 'r.json');
    fs.writeFileSync(f, '{"x": 1}');
    const r = readJsonFiles(f, '');
    expect(r.kind).toBe('ok');
    expect(r.value).toHaveLength(1);
    expect(r.value[0].read).toEqual({ kind: 'ok', value: { x: 1 } });
  });

  it('reads the matching JSON files of a directory in sorted order', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'p-b.json'), '{"n": 2}');
    fs.writeFileSync(path.join(d, 'p-a.json'), '{"n": 1}');
    fs.writeFileSync(path.join(d, 'other.json'), '{"n": 3}');
    fs.writeFileSync(path.join(d, 'p-c.txt'), 'x');
    const r = readJsonFiles(d, 'p-');
    expect(r.value.map((e: { name: string }) => e.name)).toEqual([
      'p-a.json',
      'p-b.json',
    ]);
  });

  it('does not read a directory holding more files than the limit', () => {
    const d = tmp();
    for (const n of [1, 2, 3]) {
      fs.writeFileSync(path.join(d, `p-${n}.json`), '{}');
    }
    const r = readJsonFiles(d, 'p-', { ...LIMITS, files: 2 });
    expect(r).toEqual({
      kind: 'not-read',
      reason: 'not read: 3 files is over the 2-file limit',
    });
  });

  it('reports a missing path as missing', () => {
    expect(readJsonFiles(path.join(tmp(), 'gone'), '').kind).toBe('missing');
  });
});

describe('overEntries', () => {
  it('names the entry limit when exceeded, and null otherwise', () => {
    const limits = { ...LIMITS, entries: 2 };
    expect(overEntries(3, limits)).toBe(
      'not read: 3 entries is over the 2-entry limit',
    );
    expect(overEntries(2, limits)).toBeNull();
  });
});
