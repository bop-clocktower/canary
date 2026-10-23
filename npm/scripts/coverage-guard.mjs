#!/usr/bin/env node
/**
 * Zero-file guard for the npm/ coverage run (#1444).
 *
 * `npm test` floors coverage with node's `--test-coverage-lines/branches/
 * functions`. Those thresholds are computed over whatever the include globs
 * matched, so if the globs stop matching (a `dist/` rename, a tsc `outDir`
 * change, a node release that reinterprets them) the floor passes over an
 * empty report. This guard reads the lcov file the run wrote and abstains
 * unless at least one `SF:` record names a file inside the package.
 *
 * Usage (from npm/, which is how `npm test` runs it):
 *   node scripts/coverage-guard.mjs --reset   # delete any stale report, mkdir coverage/
 *   node scripts/coverage-guard.mjs           # exit 3 unless the report covers an npm/ file
 *
 * `--reset` runs before the test run so a report left by a previous run can
 * never satisfy the check. Paths resolve against the working directory.
 */

import { mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The doctrine's abstention exit code (#508 D2): the gate checked nothing. */
const EXIT_ABSTAINED = 3;

const LCOV = join('coverage', 'lcov.info');

/** True when `file` (relative to `root`, or absolute) lies inside `root`. */
function insideRoot(file, root) {
  const rel = relative(root, resolve(root, file));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** The `SF:` paths in an lcov report that lie inside the package root. */
export function inPackageSources(lcovText, root) {
  return lcovText
    .split(/\r?\n/)
    .filter((line) => line.startsWith('SF:'))
    .map((line) => line.slice(3).trim())
    .filter((file) => insideRoot(file, root));
}

export function main(argv, { cwd = process.cwd(), out = process.stdout } = {}) {
  const lcov = join(cwd, LCOV);

  if (argv.includes('--reset')) {
    rmSync(lcov, { force: true });
    mkdirSync(join(cwd, 'coverage'), { recursive: true });
    return 0;
  }

  let text;
  try {
    text = readFileSync(lcov, 'utf-8');
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    out.write(
      `coverage-guard: abstained: ${LCOV} not found; the coverage run wrote no report.\n`,
    );
    return EXIT_ABSTAINED;
  }

  const files = inPackageSources(text, cwd);
  if (files.length === 0) {
    out.write(
      `coverage-guard: abstained: 0 npm/ files in ${LCOV}; the coverage floor measured nothing.\n`,
    );
    return EXIT_ABSTAINED;
  }
  out.write(`coverage-guard: ${LCOV} covers ${files.length} npm/ files.\n`);
  return 0;
}

/**
 * True when this module is the script node was asked to run. Real paths on
 * both sides, so a symlinked checkout cannot turn the guard into a silent
 * no-op (#1189). Inlined: this package ships none of the repo's `scripts/`.
 */
function isMain(metaUrl, entry = process.argv[1]) {
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isMain(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
