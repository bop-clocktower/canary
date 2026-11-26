/**
 * The one answer to "which files in this tree are tests?" (#755).
 *
 * Extracted from `cli-commands.ts`, where it was private, because
 * `canary-cassandra`'s skill CLI needs the SAME answer as `canary
 * vacuity-check`. The four Tier-0 detectors are meant to be mergeable by a
 * single consumer, and two collectors disagreeing about the denominator is the
 * quietest way for that to stop being true: the same run would report a
 * different `checked` depending on which door it came through.
 *
 * The walk's ignore set is load-bearing (#566): a dependency's own test suite
 * is not the consumer's to fix. One downstream run before that fix produced 254
 * of 256 findings inside `node_modules`, with the only `critical` in vendored
 * code.
 */

import { readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { JS_TEST_EXTENSIONS } from './static-linter.js';

/** True when `p` is a readable directory. A missing path is not one. */
export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Directories never worth walking; see the module docstring for why. */
const IGNORED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'build',
  '.next',
  '.nuxt',
]);

/** True when `p` is a symlink that resolves to a regular file. */
function isLinkToFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Every file under `dir`. A symlink is followed only with `links`, and only to
 * a file: a linked DIRECTORY is never walked, so a link cycle cannot loop.
 */
function walkFiles(dir: string, links = false): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!IGNORED_DIRS.has(e.name)) out.push(...walkFiles(full, links));
    } else if (e.isFile()) out.push(full);
    else if (links && e.isSymbolicLink() && isLinkToFile(full)) out.push(full);
  }
  return out;
}

/**
 * `*.test.*` / `*.spec.*` over every extension the scanners can actually read
 * -- `.mjs` and `.cjs` included, which is the half of #566 that made a
 * directory of ESM tests collect zero files. The Python half is below.
 */
const JS_TEST_FILE_RE = new RegExp(
  `\\.(test|spec)\\.(${JS_TEST_EXTENSIONS.map((e) => e.slice(1)).join('|')})$`,
);

/** Both halves of pytest's default `python_files` (#1748). */
const PY_TEST_FILE_RE = /^test_.*\.py$|_test\.py$/;

/**
 * True when a bare file name is one {@link collectTestFiles} collects -- the
 * ONE answer to "is this file name a test?". The guardian's `isTestPath`
 * calls it too, so the scanners and the PR gate cannot disagree (#1748: they
 * did, and `*_test.py` was both silently unscanned and asked for its own
 * test). Exported so a file's absence from an inventory can be read correctly
 * (#1500): a `conftest.py` is absent because no inventory ever lists it, not
 * because it was deleted.
 */
export function isCollectedTestFile(name: string): boolean {
  return PY_TEST_FILE_RE.test(name) || JS_TEST_FILE_RE.test(name);
}

/** Recursive test-file glob (union of the test patterns), sorted by path. */
export function collectTestFiles(dir: string): string[] {
  return walkFiles(dir)
    .filter((p) => isCollectedTestFile(basename(p)))
    .sort();
}

/**
 * {@link collectTestFiles} plus symlinks to test files. For asking whether a
 * test still exists (#1561), not for scanning: the inventory does not collect
 * a linked test, so its absence there says nothing about the disk.
 */
export function collectTestFilesAndLinks(dir: string): string[] {
  return walkFiles(dir, true)
    .filter((p) => isCollectedTestFile(basename(p)))
    .sort();
}

/** Human-readable list of what {@link collectTestFiles} looks for. */
export const SCANNABLE_DESC = `test_*.py, *_test.py, *.test|spec.{${JS_TEST_EXTENSIONS.map(
  (e) => e.slice(1),
).join(',')}}`;
