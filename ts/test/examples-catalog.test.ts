/**
 * Structural validation for the examples/ catalog.
 *
 * Ported from `tests/unit/test_examples_catalog.py`. Guards two invariants:
 *   1. Every example directory contains both prompt.txt and README.md.
 *   2. Every example directory is referenced in its parent README.md catalog.
 *
 * Repository-contract tests — they catch "added a directory but forgot the
 * catalog row" and "deleted an example but left a broken link" with no
 * business-logic assertions.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXAMPLES_ROOT = join(REPO_ROOT, 'examples');

// Top-level example directories (immediate children of examples/) to skip.
const TOP_LEVEL_SKIP = new Set(['realworld-functions']);

function isDir(p: string): boolean {
  return existsSync(p) && statSync(p).isDirectory();
}

/** All direct subdirectories of root that look like examples. */
function exampleDirs(root: string): string[] {
  if (!isDir(root)) return [];
  return readdirSync(root)
    .filter((name) => !name.startsWith('.') && isDir(join(root, name)))
    .sort()
    .map((name) => join(root, name));
}

/** All relative markdown link targets in a README table. */
function catalogLinks(readme: string): Set<string> {
  const text = readFileSync(readme, 'utf-8');
  const out = new Set<string>();
  for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
    out.add(m[1].replace(/\/+$/, ''));
  }
  return out;
}

describe('top-level examples', () => {
  const readme = join(EXAMPLES_ROOT, 'README.md');
  const links = existsSync(readme) ? catalogLinks(readme) : new Set<string>();
  const dirs = exampleDirs(EXAMPLES_ROOT).filter(
    (d) => !TOP_LEVEL_SKIP.has(basename(d)),
  );

  it('README exists', () => {
    expect(existsSync(readme), 'examples/README.md is missing').toBe(true);
  });

  it('each example has prompt.txt', () => {
    for (const d of dirs) {
      expect(
        existsSync(join(d, 'prompt.txt')),
        `examples/${basename(d)}/prompt.txt is missing`,
      ).toBe(true);
    }
  });

  it('each example has README.md', () => {
    for (const d of dirs) {
      expect(
        existsSync(join(d, 'README.md')),
        `examples/${basename(d)}/README.md is missing`,
      ).toBe(true);
    }
  });

  it('each example is linked in the catalog', () => {
    for (const d of dirs) {
      const name = basename(d);
      expect(
        [...links].some((link) => link.includes(name)),
        `examples/${name} is not linked from examples/README.md`,
      ).toBe(true);
    }
  });
});

describe('realworld-function examples', () => {
  const rwRoot = join(EXAMPLES_ROOT, 'realworld-functions');
  const readme = join(rwRoot, 'README.md');
  const links = existsSync(readme) ? catalogLinks(readme) : new Set<string>();
  const dirs = exampleDirs(rwRoot);

  it('realworld-functions dir exists', () => {
    expect(isDir(rwRoot), 'examples/realworld-functions/ is missing').toBe(
      true,
    );
  });

  it('README exists', () => {
    expect(
      existsSync(readme),
      'examples/realworld-functions/README.md is missing',
    ).toBe(true);
  });

  it('each example has prompt.txt', () => {
    for (const d of dirs) {
      expect(
        existsSync(join(d, 'prompt.txt')),
        `realworld-functions/${basename(d)}/prompt.txt is missing`,
      ).toBe(true);
    }
  });

  it('each example has README.md', () => {
    for (const d of dirs) {
      expect(
        existsSync(join(d, 'README.md')),
        `realworld-functions/${basename(d)}/README.md is missing`,
      ).toBe(true);
    }
  });

  it('each example is linked in the catalog', () => {
    for (const d of dirs) {
      const name = basename(d);
      expect(
        [...links].some((link) => link.includes(name)),
        `realworld-functions/${name} is not linked from its README.md`,
      ).toBe(true);
    }
  });

  it('lego-tracker example exists', () => {
    const lego = join(rwRoot, 'lego-tracker-reconcile-collection');
    expect(isDir(lego)).toBe(true);
    expect(existsSync(join(lego, 'prompt.txt'))).toBe(true);
    expect(existsSync(join(lego, 'README.md'))).toBe(true);
  });
});

function basename(p: string): string {
  return p.split(/[/\\]/).pop() ?? p;
}
