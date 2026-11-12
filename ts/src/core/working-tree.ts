/**
 * What is on disk under a root, for the one question retirement cannot answer
 * from the inventory: is this test file really gone (#1561)?
 *
 * The inventory is a snapshot, and `.canary/` is gitignored, so one written on
 * another branch survives a checkout and omits files that are there. Every
 * guard before this one trusted it. The scoring stays pure: it takes a
 * {@link WorkingTree} and the CLI builds one with {@link workingTreeAt}.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

import { collectTestFilesAndLinks } from './test-files.js';

export interface WorkingTree {
  /** True when `path`, absolute or relative to the root, exists on disk. */
  exists(path: string): boolean;
  /**
   * Every test file name the inventory collects that is on disk under the
   * root, symlinks to files included, root-relative with `/` separators.
   * Walked on first call only.
   */
  testFiles(): readonly string[];
}

export function workingTreeAt(root: string): WorkingTree {
  let walked: string[] | null = null;
  return {
    exists: (path) => existsSync(isAbsolute(path) ? path : join(root, path)),
    testFiles: () =>
      (walked ??= collectTestFilesAndLinks(root).map((p) =>
        relative(root, p).split(sep).join('/'),
      )),
  };
}
