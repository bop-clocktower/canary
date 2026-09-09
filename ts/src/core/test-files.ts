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

function walkFiles(dir: string): string[] {
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
      if (!IGNORED_DIRS.has(e.name)) out.push(...walkFiles(full));
    } else if (e.isFile()) out.push(full);
  }
  return out;
}

/**
 * `test_*.py` plus `*.test.*` / `*.spec.*` over every extension the scanners
 * can actually read -- `.mjs` and `.cjs` included, which is the half of #566
 * that made a directory of ESM tests collect zero files.
 */
const JS_TEST_FILE_RE = new RegExp(
  `\\.(test|spec)\\.(${JS_TEST_EXTENSIONS.map((e) => e.slice(1)).join('|')})$`,
);

/** Recursive test-file glob matching Python's `rglob` union, sorted by path. */
export function collectTestFiles(dir: string): string[] {
  return walkFiles(dir)
    .filter((p) => {
      const b = basename(p);
      return (
        (b.startsWith('test_') && b.endsWith('.py')) || JS_TEST_FILE_RE.test(b)
      );
    })
    .sort();
}

/** Human-readable list of what {@link collectTestFiles} looks for. */
export const SCANNABLE_DESC = `test_*.py, *.test|spec.{${JS_TEST_EXTENSIONS.map(
  (e) => e.slice(1),
).join(',')}}`;
