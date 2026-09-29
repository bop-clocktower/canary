/**
 * canary-judomaster frame resolver (#614): trace paths captured on another
 * machine resolve to files under a synthetic repository root.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveFrames } from '../src/analysis/judomaster/resolve.js';

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

const one = (file: string, line = 12) =>
  resolveFrames([{ file, line }], root)[0]!;

describe('resolveFrames', () => {
  it('resolves a foreign absolute path by its longest existing suffix', () => {
    const f = one('/app/src/cart/total.ts');
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
    const f = one('src/cart/total.ts');
    expect(f.status).toBe('resolved');
    expect(f.path).toBe('src/cart/total.ts');
  });

  it('flags a line past the end of the file as stale', () => {
    const f = one('/app/src/cart/total.ts', 99);
    expect(f.status).toBe('stale');
    expect(f.path).toBe('src/cart/total.ts');
  });

  it.each([
    '/app/node_modules/x/i.js',
    '/usr/lib/python3/site-packages/y.py',
    'node:internal/modules/cjs/loader',
    '<anonymous>',
  ])('names %s as external', (file) => {
    const f = one(file);
    expect(f.status).toBe('external');
    expect(f.path).toBeUndefined();
  });

  it('names a path that exists nowhere under root as missing', () => {
    expect(one('/app/src/gone.ts').status).toBe('missing');
  });

  it('never resolves a path that escapes root via ..', () => {
    expect(one('../outside/secret.ts', 1).status).toBe('missing');
    expect(one('src/../../outside/secret.ts', 1).status).toBe('missing');
  });
});
