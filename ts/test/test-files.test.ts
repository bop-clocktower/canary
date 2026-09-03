/**
 * The shared test-file collector (#755).
 *
 * Extracted from `cli-commands.ts` so `canary vacuity-check` and the
 * `canary-cassandra` skill CLI ask the same question and get the same answer.
 * Two collectors is the quiet way for the four Tier-0 detectors to stop being
 * mergeable: the same suite would report a different `checked` depending on
 * which door the caller came through, and neither number would look wrong.
 *
 * The ignore set is the half with history (#566): one downstream run produced
 * 254 of 256 findings inside `node_modules`, with the only `critical` in
 * vendored code.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  SCANNABLE_DESC,
  collectTestFiles,
  isDir,
} from '../src/core/test-files.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Build a tree from `path -> contents`, creating parents as needed. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'canary-collect-'));
  dirs.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body, 'utf-8');
  }
  return root;
}

describe('isDir', () => {
  it('is true for a directory and false for a file', () => {
    const root = tree({ 'a.test.ts': '' });
    expect(isDir(root)).toBe(true);
    expect(isDir(join(root, 'a.test.ts'))).toBe(false);
  });

  it('is false, not throwing, for a path that does not exist', () => {
    expect(isDir(join(tmpdir(), 'canary-no-such-dir-at-all'))).toBe(false);
  });
});

describe('collectTestFiles', () => {
  it('collects every JS/TS test suffix the scanners can read', () => {
    // #566's other half: an `.mjs`-only test directory collected zero files.
    const root = tree({
      'a.test.ts': '',
      'b.spec.js': '',
      'c.test.mjs': '',
      'd.spec.cjs': '',
      'e.test.mts': '',
      'f.spec.cts': '',
    });
    expect(collectTestFiles(root).map((p) => basename(p))).toEqual([
      'a.test.ts',
      'b.spec.js',
      'c.test.mjs',
      'd.spec.cjs',
      'e.test.mts',
      'f.spec.cts',
    ]);
  });

  it('collects pytest-style test_*.py and nothing else Python', () => {
    const root = tree({
      'test_thing.py': '',
      'thing_test.py': '',
      'app.py': '',
    });
    expect(collectTestFiles(root).map((p) => basename(p))).toEqual([
      'test_thing.py',
    ]);
  });

  it('ignores non-test files entirely', () => {
    const root = tree({ 'index.ts': '', 'README.md': '', 'a.test.ts': '' });
    expect(collectTestFiles(root)).toHaveLength(1);
  });

  it('never walks into a dependency, build output, or VCS directory', () => {
    const root = tree({
      'own.test.ts': '',
      'node_modules/dep/vendored.test.ts': '',
      'dist/built.test.js': '',
      'build/built.test.js': '',
      '.git/hook.test.js': '',
      '.venv/lib/x.test.js': '',
    });
    expect(collectTestFiles(root).map((p) => basename(p))).toEqual([
      'own.test.ts',
    ]);
  });

  it('recurses into ordinary subdirectories, sorted by path', () => {
    const root = tree({ 'z/z.test.ts': '', 'a/a.test.ts': '' });
    const found = collectTestFiles(root);
    expect(found).toHaveLength(2);
    expect(found[0]).toContain(join('a', 'a.test.ts'));
    expect(found[1]).toContain(join('z', 'z.test.ts'));
  });

  it('returns an empty list, not a throw, for a path it cannot read', () => {
    expect(collectTestFiles(join(tmpdir(), 'canary-no-such-tree'))).toEqual([]);
  });
});

describe('SCANNABLE_DESC', () => {
  it('names what the collector actually looks for, for remedy text', () => {
    // Derived from the extension list, so it cannot drift behind it -- an
    // abstention whose remedy names the wrong glob sends the reader nowhere.
    expect(SCANNABLE_DESC).toContain('test_*.py');
    for (const ext of ['ts', 'js', 'mjs', 'cjs']) {
      expect(SCANNABLE_DESC).toContain(ext);
    }
  });
});
