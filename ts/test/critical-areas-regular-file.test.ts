/**
 * `readRegularFile` (#1575): the one way critical-areas reads a path a scanned
 * tree controls. Only a regular file, never through a symlink, never past the
 * cap. A FIFO is opened non-blocking, so these cases are safe in-process.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_TREE_READ_BYTES,
  readRegularFile,
} from '../src/critical-areas/regular-file.js';
import { mkTmp, rmTmp } from './canary-cli-testkit.js';

describe('readRegularFile', () => {
  let root: string;
  beforeEach(() => {
    root = mkTmp();
  });
  afterEach(() => {
    rmTmp(root);
  });

  it('reads a regular file as UTF-8', () => {
    writeFileSync(join(root, 'a.ts'), "import 'ä';\n", 'utf-8');
    expect(readRegularFile(join(root, 'a.ts'))).toBe("import 'ä';\n");
  });

  it('is null for a missing file', () => {
    expect(readRegularFile(join(root, 'gone.ts'))).toBeNull();
  });

  it('is null for a directory', () => {
    mkdirSync(join(root, 'dir'));
    expect(readRegularFile(join(root, 'dir'))).toBeNull();
  });

  it('reads a file at the cap and refuses one byte past it', () => {
    const path = join(root, 'big.ts');
    writeFileSync(path, '');
    truncateSync(path, MAX_TREE_READ_BYTES);
    expect(readRegularFile(path)?.length).toBe(MAX_TREE_READ_BYTES);
    truncateSync(path, MAX_TREE_READ_BYTES + 1);
    expect(readRegularFile(path)).toBeNull();
  });

  it('honours a smaller cap', () => {
    writeFileSync(join(root, 'a.ts'), '12345');
    expect(readRegularFile(join(root, 'a.ts'), 5)).toBe('12345');
    expect(readRegularFile(join(root, 'a.ts'), 4)).toBeNull();
  });

  describe.skipIf(process.platform === 'win32')('non-regular paths', () => {
    it('is null for /dev/zero itself', () => {
      expect(readRegularFile('/dev/zero')).toBeNull();
    });

    it('is null for a symlink to /dev/zero', () => {
      symlinkSync('/dev/zero', join(root, 'z.ts'));
      expect(readRegularFile(join(root, 'z.ts'))).toBeNull();
    });

    it('is null for a symlink to a regular file', () => {
      writeFileSync(join(root, 'real.ts'), 'x');
      symlinkSync(join(root, 'real.ts'), join(root, 'l.ts'));
      expect(readRegularFile(join(root, 'l.ts'))).toBeNull();
    });

    it('is null for a FIFO with no writer, without blocking', () => {
      const pipe = join(root, 'pipe');
      expect(spawnSync('mkfifo', [pipe]).status).toBe(0);
      expect(readRegularFile(pipe)).toBeNull();
    });
  });
});
