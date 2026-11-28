/**
 * canary-batgirl's escaping helper and bounded reads (#619, spec D9, D10).
 *
 * Every value that reaches batgirl's output came from a file a branch controls:
 * a path, a branch name, a ledger or history value. `plain` makes it one inert
 * line; `md` additionally makes it inert Markdown, including GFM autolinks.
 * The bounded reads keep a hostile input from making any later scan large, and
 * keep every read inside the working directory: a symlink is never followed,
 * and a parse error never quotes the file it failed on.
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
  parseJson,
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

  it('defangs a scheme URL, so GFM cannot autolink it', () => {
    const out = md('see https://evil.example/x');
    expect(out).not.toContain('://');
    expect(out).toBe('see https\\[:\\]//evil.example/x');
  });

  it('defangs a www. link, at the start and mid-text, any case', () => {
    for (const text of ['www.evil.example', 'go WWW.evil.example']) {
      const out = md(text);
      expect(out).not.toMatch(/www\./i);
      expect(out).toMatch(/www\\\[\.\\\]/i);
    }
  });

  it('defangs a bare email address', () => {
    const out = md('mail someone@evil.example');
    expect(out).not.toContain('someone@');
    expect(out).toBe('mail someone\\[@\\]evil.example');
  });

  it('leaves plain() untouched by the defanging (JSON stays exact)', () => {
    expect(plain('https://a.example someone@b.example')).toBe(
      'https://a.example someone@b.example',
    );
  });
});

describe('parseJson', () => {
  it('parses JSON', () => {
    expect(parseJson('{"a": 1}')).toEqual({ kind: 'ok', value: { a: 1 } });
  });

  it('reports a parse error by name and position, quoting no input byte', () => {
    const secret = 'SECRET-TOKEN-1234';
    const r = parseJson(`{"k": ${secret}}`);
    expect(r.kind).toBe('invalid');
    expect(r.reason).toMatch(
      /^not valid JSON: SyntaxError (at position \d+|\(no position given\))$/,
    );
    expect(r.reason).not.toContain('SECRET');
    expect(r.reason).not.toContain('"k"');
  });
});

describe('readText', () => {
  it('reports a missing file as missing', () => {
    const root = tmp();
    expect(readText(path.join(root, 'nope.json'), { root }).kind).toBe(
      'missing',
    );
  });

  it('refuses a directory or any other non-regular file', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'd'));
    expect(readText(path.join(root, 'd'), { root })).toEqual({
      kind: 'unreadable',
      reason: 'not a regular file',
    });
  });

  it('refuses a path outside the working directory', () => {
    const root = tmp();
    const other = tmp();
    fs.writeFileSync(path.join(other, 'x.json'), '{}');
    expect(readText(path.join(other, 'x.json'), { root })).toEqual({
      kind: 'unreadable',
      reason: 'outside the working directory',
    });
    expect(readText('../x.json', { root }).kind).toBe('unreadable');
  });

  it('does not follow a symlinked file, or a symlinked parent directory', () => {
    const root = tmp();
    const other = tmp();
    fs.writeFileSync(path.join(other, 'x.json'), '{"leak": true}');
    fs.symlinkSync(path.join(other, 'x.json'), path.join(root, 'link.json'));
    fs.symlinkSync(other, path.join(root, 'linkdir'), 'dir');
    for (const p of ['link.json', 'linkdir/x.json']) {
      expect(readText(path.join(root, p), { root })).toEqual({
        kind: 'not-read',
        reason: 'not read: symlink',
      });
    }
  });

  it('does not read a file over the byte limit', () => {
    const root = tmp();
    const f = path.join(root, 'big.json');
    fs.writeFileSync(f, 'x'.repeat(64));
    const r = readText(f, { root, limits: { ...LIMITS, bytes: 16 } });
    expect(r).toEqual({
      kind: 'not-read',
      reason: 'not read: 64 bytes is over the 16-byte limit',
    });
  });

  it('reads a regular file within the limit, relative to the root', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'ok.txt'), 'hello');
    expect(readText('ok.txt', { root })).toEqual({
      kind: 'ok',
      value: 'hello',
    });
  });
});

describe('readJson', () => {
  it('parses a JSON file', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'a.json'), '{"a": 1}');
    expect(readJson('a.json', { root })).toEqual({
      kind: 'ok',
      value: { a: 1 },
    });
  });

  it('reports a malformed file without echoing any of its bytes', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'a.json'), '{"x": PLANTED-BYTES-9}');
    const r = readJson('a.json', { root });
    expect(r.kind).toBe('invalid');
    expect(r.reason).not.toContain('PLANTED');
    expect(r.reason).not.toContain('"x"');
  });

  it('passes a not-read result through without parsing', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'a.json'), '{"a": 1}');
    const limits = { ...LIMITS, bytes: 2 };
    expect(readJson('a.json', { root, limits }).kind).toBe('not-read');
  });
});

describe('readJsonFiles', () => {
  it('reads one gated file as a one-element list', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'p-r.json'), '{"x": 1}');
    const r = readJsonFiles('p-r.json', 'p-', { root });
    expect(r.kind).toBe('ok');
    expect(r.value).toHaveLength(1);
    expect(r.value[0].read).toEqual({ kind: 'ok', value: { x: 1 } });
  });

  it('applies the prefix and .json gate to a single file too', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'other.json'), '{}');
    fs.writeFileSync(path.join(root, 'p-r.txt'), '{}');
    for (const name of ['other.json', 'p-r.txt']) {
      expect(readJsonFiles(name, 'p-', { root })).toEqual({
        kind: 'unreadable',
        reason: 'not a p-*.json file',
      });
    }
  });

  it('refuses a target that is neither a regular file nor a directory', () => {
    const root = tmp();
    const other = tmp();
    fs.symlinkSync(other, path.join(root, 'p-link.json'), 'dir');
    expect(readJsonFiles('p-link.json', 'p-', { root })).toEqual({
      kind: 'not-read',
      reason: 'not read: symlink',
    });
  });

  it('reads the matching JSON files of a directory in sorted order', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'p-b.json'), '{"n": 2}');
    fs.writeFileSync(path.join(root, 'p-a.json'), '{"n": 1}');
    fs.writeFileSync(path.join(root, 'other.json'), '{"n": 3}');
    fs.writeFileSync(path.join(root, 'p-c.txt'), 'x');
    const r = readJsonFiles(root, 'p-', { root });
    expect(r.value.map((e: { name: string }) => e.name)).toEqual([
      'p-a.json',
      'p-b.json',
    ]);
  });

  it('reports a symlinked entry pointing outside the root as not read', () => {
    const root = tmp();
    const other = tmp();
    fs.writeFileSync(path.join(other, 'secret.json'), '{"leak": "LEAKED"}');
    fs.mkdirSync(path.join(root, 'records'));
    fs.writeFileSync(path.join(root, 'records', 'p-a.json'), '{"n": 1}');
    fs.symlinkSync(
      path.join(other, 'secret.json'),
      path.join(root, 'records', 'p-z.json'),
    );
    const r = readJsonFiles('records', 'p-', { root });
    expect(r.value).toEqual([
      { name: 'p-a.json', read: { kind: 'ok', value: { n: 1 } } },
      {
        name: 'p-z.json',
        read: { kind: 'not-read', reason: 'not read: symlink' },
      },
    ]);
    expect(JSON.stringify(r)).not.toContain('LEAKED');
  });

  it('reports a non-regular directory entry as unreadable', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'p-dir.json'));
    const r = readJsonFiles(root, 'p-', { root });
    expect(r.value[0].read).toEqual({
      kind: 'unreadable',
      reason: 'not a regular file',
    });
  });

  it('does not read a directory holding more files than the limit', () => {
    const root = tmp();
    for (const n of [1, 2, 3]) {
      fs.writeFileSync(path.join(root, `p-${n}.json`), '{}');
    }
    const limits = { ...LIMITS, files: 2 };
    expect(readJsonFiles(root, 'p-', { root, limits })).toEqual({
      kind: 'not-read',
      reason: 'not read: 3 files is over the 2-file limit',
    });
  });

  it('reports a missing path as missing', () => {
    const root = tmp();
    expect(readJsonFiles('gone', '', { root }).kind).toBe('missing');
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
