// canary-hawk-dove's file boundary (#618): every read stays inside the
// realpath'd repository, refuses symlinks and non-regular files, gates the
// extension and size, and every write fails cleanly.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  appendInside,
  readInside,
  writeOut,
} from '../claude-code/canary-hawk-dove/scripts/files.mjs';

const dirs: string[] = [];
function tmp(): string {
  const d = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'hd-files-')),
  );
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const JSON_GATE = { ext: '.json', maxBytes: 64 };

describe('readInside', () => {
  it('reads a regular .json file inside the root', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'run.json'), '{}');
    expect(readInside(root, 'run.json', JSON_GATE)).toEqual({
      text: '{}',
      rel: 'run.json',
    });
  });

  it('refuses a path outside the root', () => {
    const root = tmp();
    const other = tmp();
    fs.writeFileSync(path.join(other, 'x.json'), '{}');
    expect(readInside(root, path.join(other, 'x.json'), JSON_GATE)).toEqual({
      notRead: 'outside the repository',
    });
    expect(readInside(root, '../x.json', JSON_GATE).notRead).toBe(
      'outside the repository',
    );
  });

  it('reports a symlinked file as not read: symlink, even inside the root', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'real.json'), '{}');
    fs.symlinkSync(path.join(root, 'real.json'), path.join(root, 'link.json'));
    expect(readInside(root, 'link.json', JSON_GATE)).toEqual({
      notRead: 'symlink',
    });
  });

  it('reports a symlinked parent directory as a symlink', () => {
    const root = tmp();
    const outside = tmp();
    fs.writeFileSync(path.join(outside, 'x.json'), '{}');
    fs.symlinkSync(outside, path.join(root, 'sub'));
    expect(readInside(root, 'sub/x.json', JSON_GATE)).toEqual({
      notRead: 'symlink',
    });
  });

  it('rejects a directory explicitly, even one named like a json file', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'dir.json'));
    expect(readInside(root, 'dir.json', JSON_GATE)).toEqual({
      notRead: 'not a regular file',
    });
  });

  it('applies the extension gate to a single file', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'run.txt'), '{}');
    expect(readInside(root, 'run.txt', JSON_GATE)).toEqual({
      notRead: 'not a .json file',
    });
  });

  it('reports an oversized file instead of reading part of it', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'big.json'), 'x'.repeat(65));
    expect(readInside(root, 'big.json', JSON_GATE)).toEqual({
      notRead: 'larger than 64 bytes',
    });
  });

  it('reports a missing file as missing', () => {
    const root = tmp();
    expect(readInside(root, 'nope.json', JSON_GATE)).toEqual({
      notRead: 'missing',
    });
  });
});

describe('appendInside', () => {
  it('creates parents and appends without touching existing bytes', () => {
    const root = tmp();
    expect(appendInside(root, 'a/b/l.jsonl', 'one\n')).toBeNull();
    expect(appendInside(root, 'a/b/l.jsonl', 'two\n')).toBeNull();
    expect(fs.readFileSync(path.join(root, 'a/b/l.jsonl'), 'utf8')).toBe(
      'one\ntwo\n',
    );
  });

  it('refuses to write through a symlinked parent or outside the root', () => {
    const root = tmp();
    const outside = tmp();
    fs.symlinkSync(outside, path.join(root, 'sub'));
    expect(appendInside(root, 'sub/l.jsonl', 'x\n')).toBe(
      'not written: symlink',
    );
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(appendInside(root, '../l.jsonl', 'x\n')).toBe(
      'not written: outside the repository',
    );
  });
});

describe('writeOut', () => {
  it('creates parent directories', () => {
    const root = tmp();
    const out = path.join(root, 'deep', 'r.md');
    expect(writeOut(out, 'hi')).toBeNull();
    expect(fs.readFileSync(out, 'utf8')).toBe('hi\n');
  });

  it('returns a clean cannot-write message', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'file'), '');
    const msg = writeOut(path.join(root, 'file', 'r.md'), 'hi');
    expect(msg).toMatch(/^cannot write .*r\.md: E[A-Z]+$/);
  });
});
