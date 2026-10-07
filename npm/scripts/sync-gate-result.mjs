#!/usr/bin/env node
/**
 * Mirror zero-import engine modules into this CommonJS package (#508 Wave 3,
 * #1206). Named for its first mirror; it now carries every entry in `MIRRORS`.
 *
 * Each mirrored module must have exactly one source of truth under
 * `ts/src/core/`, but the npm package cannot import it:
 *
 *   - `npm/package.json` declares no `"type"`, so this package is CommonJS,
 *     while the staged engine bundle (`dist/engine/package.json`) is ESM — a
 *     `require()` across that boundary is impossible;
 *   - npm's `test` script is `tsc && node --test`, which never runs
 *     `build-engine.mjs`, so `dist/engine/` is frequently absent when the suite
 *     runs in CI. A dynamic `await import()` bridge would pass locally and fail
 *     there.
 *
 * Every mirrored source has ZERO imports — pure policy or pure data — so the
 * identical source compiles correctly under both module systems. This script
 * copies each verbatim (behind a generated-file banner) and, in `--check`
 * mode, fails when any copy has drifted. `--check` is npm's `pretest`: file
 * reads and string compares, no compile, so the drift gate costs nothing.
 *
 *   - `gate-result.ts` — the abstention doctrine helper (#508 D2);
 *   - `test-shapes.ts` — the shape vocabulary `overlay lint` validates
 *     `deploy_to` against, so the lint can never again fall behind the shapes
 *     the classifier and probes emit (#1206).
 *
 * Usage:
 *   node scripts/sync-gate-result.mjs            # write the copies
 *   node scripts/sync-gate-result.mjs --check    # exit 1 if any has drifted
 *
 * Exit 3 (abstained) when an engine source is unreadable inside a canary
 * checkout; outside one there is nothing to compare, so it notes the skip
 * and exits 0.
 */

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const npmRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const repoRoot = resolve(npmRoot, '..');
const engineCore = resolve(repoRoot, 'ts', 'src', 'core');

/** The doctrine's abstention exit code (#508 D2): the gate checked nothing. */
const EXIT_ABSTAINED = 3;

/**
 * True when this package sits inside a canary checkout rather than a tree
 * that genuinely has no engine sources. Keyed on markers that exist beside
 * `npm/` in every checkout and worktree (`.git` is a file in a worktree), not
 * on the engine source itself: "the source is missing" is the failure being
 * judged, so it cannot also be the evidence of where we are (#1196).
 */
function insideRepo() {
  return ['ts/package.json', '.git'].some((marker) =>
    existsSync(join(repoRoot, marker)),
  );
}

/** Each mirrored module: its engine source of truth and generated CJS copy. */
export const MIRRORS = ['gate-result.ts', 'test-shapes.ts'].map((file) => ({
  file,
  source: join(engineCore, file),
  target: join(npmRoot, 'src', file),
}));

const banner = (file) => `// GENERATED FILE — DO NOT EDIT.
// Verbatim copy of ts/src/core/${file}, mirrored into this CommonJS
// package by scripts/sync-gate-result.mjs because the staged engine bundle is
// ESM and unavailable at test time. Edit the engine source and re-run:
//   node scripts/sync-gate-result.mjs
// \`npm test\` verifies this copy has not drifted (--check runs as pretest).
`;

/** The exact bytes the mirror of `file` should hold for a given source. */
export function render(source, file) {
  return `${banner(file)}\n${source}`;
}

/** Sync (or, with `check`, verify) one mirror. Returns an exit code. */
function syncOne({ file, source: sourcePath, target }, check) {
  let source;
  try {
    source = readFileSync(sourcePath, 'utf-8');
  } catch {
    // Inside the repo a missing or unreadable source means the gate compared
    // nothing — a loud abstention, never a quiet pass (#1196). Outside one
    // (no engine sources ship with the package) the already-generated copy
    // is what matters: succeed, but say the check did not run.
    if (insideRepo()) {
      process.stderr.write(
        `sync-gate-result: ABSTAINED — cannot read ${sourcePath}, so ` +
          `npm/src/${file} was not checked.\n` +
          '  Restore the engine source (or update MIRRORS if it moved).\n',
      );
      return EXIT_ABSTAINED;
    }
    process.stdout.write(
      `sync-gate-result: skipped npm/src/${file} — no engine source ` +
        'outside a canary checkout.\n',
    );
    return 0;
  }
  const expected = render(source, file);

  if (check) {
    let actual = null;
    try {
      actual = readFileSync(target, 'utf-8');
    } catch {
      // fall through to the drift report
    }
    if (actual === expected) return 0;
    process.stderr.write(
      `sync-gate-result: npm/src/${file} has drifted from ` +
        `ts/src/core/${file}.\n` +
        '  A mirrored engine module must have one source of truth ' +
        '(#508 D2, #1206).\n' +
        '  Fix: edit the engine source, then run ' +
        '`node scripts/sync-gate-result.mjs` from npm/.\n',
    );
    return 1;
  }

  writeFileSync(target, expected, 'utf-8');
  process.stdout.write(`sync-gate-result: wrote ${target}\n`);
  return 0;
}

function main(argv) {
  const check = argv.includes('--check');
  // Every mirror is visited even after a failure, so one run names them all.
  // A drift outranks an abstention: it proves something was checked.
  const codes = MIRRORS.map((m) => syncOne(m, check));
  if (codes.includes(1)) return 1;
  return codes.includes(EXIT_ABSTAINED) ? EXIT_ABSTAINED : 0;
}

/**
 * True when this module is the script node was asked to run. Compares
 * resolved real paths: `import.meta.url` is always the real path, so a plain
 * comparison with `process.argv[1]` is false through a symlink, and the drift
 * gate then exited 0 without checking anything (#1189). Inlined rather than
 * shared because this package ships none of the repo's `scripts/` tree.
 */
function isMain(metaUrl, entry = process.argv[1]) {
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(entry);
  } catch {
    return false;
  }
}

// Only act when run as a script; importing for tests must have no side effects.
if (isMain(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}

export { main };
