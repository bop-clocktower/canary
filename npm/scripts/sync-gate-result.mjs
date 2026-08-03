#!/usr/bin/env node
/**
 * Mirror the engine's gate-abstention helper into this CommonJS package (#508
 * Wave 3).
 *
 * The doctrine helper must have exactly one source of truth
 * (`ts/src/core/gate-result.ts`), but the npm package cannot import it:
 *
 *   - `npm/package.json` declares no `"type"`, so this package is CommonJS,
 *     while the staged engine bundle (`dist/engine/package.json`) is ESM — a
 *     `require()` across that boundary is impossible;
 *   - npm's `test` script is `tsc && node --test`, which never runs
 *     `build-engine.mjs`, so `dist/engine/` is frequently absent when the suite
 *     runs in CI. A dynamic `await import()` bridge would pass locally and fail
 *     there.
 *
 * `gate-result.ts` has ZERO imports — pure policy — so the identical source
 * compiles correctly under both module systems. This script copies it verbatim
 * (behind a generated-file banner) and, in `--check` mode, fails when the copy
 * has drifted. `--check` is npm's `pretest`: a file read and a string compare,
 * no compile, so the drift gate costs nothing.
 *
 * Usage:
 *   node scripts/sync-gate-result.mjs            # write the copy
 *   node scripts/sync-gate-result.mjs --check    # exit 1 if it has drifted
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const npmRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Source of truth: the engine helper Wave 1 shipped. */
export const SOURCE = resolve(
  npmRoot,
  '..',
  'ts',
  'src',
  'core',
  'gate-result.ts',
);

/** Generated mirror, compiled to CJS by this package's own tsconfig. */
export const TARGET = join(npmRoot, 'src', 'gate-result.ts');

const BANNER = `// GENERATED FILE — DO NOT EDIT.
// Verbatim copy of ts/src/core/gate-result.ts, mirrored into this CommonJS
// package by scripts/sync-gate-result.mjs because the staged engine bundle is
// ESM and unavailable at test time. Edit the engine source and re-run:
//   node scripts/sync-gate-result.mjs
// \`npm test\` verifies this copy has not drifted (--check runs as pretest).
`;

/** The exact bytes the mirror should hold for a given engine source. */
export function render(source) {
  return `${BANNER}\n${source}`;
}

function main(argv) {
  let source;
  try {
    source = readFileSync(SOURCE, 'utf-8');
  } catch {
    // The engine source is absent in a published tarball (`files` ships only
    // bin/ and dist/), where the already-generated copy is what matters.
    // Nothing to sync and nothing to verify — succeed quietly.
    return 0;
  }
  const expected = render(source);

  if (argv.includes('--check')) {
    let actual = null;
    try {
      actual = readFileSync(TARGET, 'utf-8');
    } catch {
      // fall through to the drift report
    }
    if (actual === expected) return 0;
    process.stderr.write(
      'sync-gate-result: npm/src/gate-result.ts has drifted from ' +
        'ts/src/core/gate-result.ts.\n' +
        '  The abstention doctrine must have one source of truth (#508 D2).\n' +
        '  Fix: edit the engine source, then run ' +
        '`node scripts/sync-gate-result.mjs` from npm/.\n',
    );
    return 1;
  }

  writeFileSync(TARGET, expected, 'utf-8');
  process.stdout.write(`sync-gate-result: wrote ${TARGET}\n`);
  return 0;
}

// Only act when run as a script; importing for tests must have no side effects.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}

export { main };
