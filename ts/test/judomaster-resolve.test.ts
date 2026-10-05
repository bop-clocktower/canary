/**
 * canary-judomaster frame resolver (#614): trace paths captured on another
 * machine resolve to files under a synthetic repository root.
 */

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isWithin, resolveFrames } from '../src/analysis/judomaster/resolve.js';

let base: string;
let root: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'judomaster-resolve-'));
  root = join(base, 'repo');
  mkdirSync(join(root, 'src', 'cart'), { recursive: true });
  const body = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  writeFileSync(join(root, 'src', 'cart', 'total.ts'), body.join('\n'));
  mkdirSync(join(base, 'outside'));
  writeFileSync(join(base, 'outside', 'secret.ts'), 'secret\n');
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('resolveFrames', () => {
  it('resolves a foreign absolute path by its longest existing suffix', () => {
    const f = resolveFrames(
      [{ file: '/app/src/cart/total.ts', line: 12 }],
      root,
    )[0]!;
    expect(f.status).toBe('resolved');
    expect(f.path).toBe('src/cart/total.ts');
    expect(f.excerpt).toEqual([
      'line 10',
      'line 11',
      'line 12',
      'line 13',
      'line 14',
    ]);
    expect(f.file).toBe('/app/src/cart/total.ts');
  });

  it('resolves a root-relative path as given', () => {
    const f = resolveFrames(
      [{ file: 'src/cart/total.ts', line: 12 }],
      root,
    )[0]!;
    expect(f.status).toBe('resolved');
    expect(f.path).toBe('src/cart/total.ts');
  });

  it('flags a line past the end of the file as stale', () => {
    const f = resolveFrames(
      [{ file: '/app/src/cart/total.ts', line: 99 }],
      root,
    )[0]!;
    expect(f.status).toBe('stale');
    expect(f.path).toBe('src/cart/total.ts');
  });

  it.each([
    '/app/node_modules/x/i.js',
    '/usr/lib/python3/site-packages/y.py',
    'node:internal/modules/cjs/loader',
    '<anonymous>',
  ])('names %s as external', (file) => {
    const f = resolveFrames([{ file: file, line: 12 }], root)[0]!;
    expect(f.status).toBe('external');
    expect(f.path).toBeUndefined();
  });

  it('names a path that exists nowhere under root as missing', () => {
    expect(
      resolveFrames([{ file: '/app/src/gone.ts', line: 12 }], root)[0]!.status,
    ).toBe('missing');
  });

  it('never resolves a path that escapes root via ..', () => {
    expect(
      resolveFrames([{ file: '../outside/secret.ts', line: 1 }], root)[0]!
        .status,
    ).toBe('missing');
    expect(
      resolveFrames(
        [{ file: 'src/../../outside/secret.ts', line: 1 }],
        root,
      )[0]!.status,
    ).toBe('missing');
  });
});

describe('isWithin', () => {
  it('is true for a path strictly inside the base, including root /', () => {
    expect(isWithin('/', '/a/b')).toBe(true);
    expect(isWithin('/repo', '/repo/..foo')).toBe(true);
  });

  it('is false for a sibling with a shared prefix, the base itself, or a parent', () => {
    expect(isWithin('/repo', '/repo-other/x')).toBe(false);
    expect(isWithin('/repo', '/repo')).toBe(false);
    expect(isWithin('/repo', '/')).toBe(false);
  });
});

describe('resolveFrames containment', () => {
  it('resolves an absolute in-repo frame when the root is /', () => {
    const real = realpathSync(join(root, 'src', 'cart', 'total.ts'));
    const f = resolveFrames([{ file: real, line: 3 }], '/')[0]!;
    expect(f.status).toBe('resolved');
    expect(f.path).toBe(real.slice(1));
  });

  it('never resolves a frame under a sibling repo-other directory', () => {
    mkdirSync(join(base, 'repo-other', 'src'), { recursive: true });
    const other = join(base, 'repo-other', 'src', 'a.ts');
    writeFileSync(other, 'a\n');
    const f = resolveFrames([{ file: other, line: 1 }], root)[0]!;
    expect(f.status).toBe('missing');
  });
});
