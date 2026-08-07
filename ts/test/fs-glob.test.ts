import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { globDirs, globFiles, readTextOrNull } from '../src/core/fs-glob.js';

function withTmp<T>(fn: (tmp: string) => T): T {
  const tmp = mkdtempSync(join(tmpdir(), 'canary-fsglob-'));
  try {
    return fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe('fs-glob', () => {
  it('matches files through a ** segment', () =>
    withTmp((tmp) => {
      mkdirSync(join(tmp, 'tests', 'deep'), { recursive: true });
      writeFileSync(join(tmp, 'tests', 'deep', 'a.spec.ts'), '');
      expect(globFiles(tmp, 'tests/**/*.spec.ts')).toHaveLength(1);
    }));

  it('never descends into node_modules when matching directories', () =>
    withTmp((tmp) => {
      mkdirSync(join(tmp, 'apps', 'web'), { recursive: true });
      mkdirSync(join(tmp, 'node_modules', 'pkg'), { recursive: true });
      expect(globDirs(tmp, '*/*')).toEqual([join(tmp, 'apps', 'web')]);
    }));

  it('returns null for an unreadable path', () =>
    withTmp((tmp) => {
      expect(readTextOrNull(join(tmp, 'nope.txt'))).toBeNull();
    }));
});
