// Built-engine precondition for the agents/skills suite (#1221).
//
// canary-cassandra's CLI delegates to the engine's vacuity scanner rather than
// carrying a second copy of the rules (see its scripts/engine.mjs), so
// test/canary-cassandra.test.ts and the cassandra rows of
// test/gate-conformance.test.ts need a built `ts/dist`. Without one, an
// unbuilt worktree reported 16 assertion failures that looked like real bugs.
//
// This runs once as vitest `globalSetup` and fails the run with ONE message
// naming the missing build. It resolves the engine with the CLI's own
// `resolveEngineDir`, so it checks exactly what the tests depend on — the same
// candidate list (CANARY_ENGINE_DIR, ts/dist, dist/engine) and the same three
// modules — and cannot drift from it.
//
// A STALE build is only warned about. The signal is "some ts/src file is newer
// than every ts/dist output": ts/tsconfig.json is not incremental, so a build
// rewrites every output and a later source edit is the only way to get there.
// It is a heuristic (mtimes move on checkout and touch), so it must not block.
// Skipping the suite is deliberately not an option either: a skipped suite is a
// zero denominator wearing a tick.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  engineCandidates,
  resolveEngineDir,
} from '../claude-code/canary-cassandra/scripts/engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// test -> skills -> agents -> <root>
const ROOT = path.resolve(HERE, '..', '..', '..');

export interface EnginePreconditionOptions {
  /** Engine directories to try, highest priority first. */
  candidates?: string[];
  /** The source tree whose edits make a checkout build stale. */
  srcDir?: string;
  /** Where the staleness warning goes. */
  warn?: (message: string) => void;
}

/** Newest mtime (ms) of the files under `dir` matching `ext`; 0 when none. */
function newestMtime(dir: string, ext: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !entry.name.endsWith(ext)) continue;
    const mtime = fs.statSync(path.join(entry.parentPath, entry.name)).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

/**
 * Resolve the built engine or throw one error naming the missing build.
 *
 * @returns the engine directory the cassandra CLI will load.
 */
export function checkEnginePrecondition(
  options: EnginePreconditionOptions = {},
): string {
  const candidates = options.candidates ?? engineCandidates();
  const srcDir = options.srcDir ?? path.join(ROOT, 'ts', 'src');
  const warn = options.warn ?? ((m: string) => console.warn(m));

  const dir = resolveEngineDir(candidates);
  if (dir === null) {
    throw new Error(
      'ts/dist missing — run `npm run build` in ts/ (or `npm --prefix ts run ' +
        'build` from the repo root) before this suite. canary-cassandra and ' +
        'gate-conformance load the built vacuity engine. Tried: ' +
        `${candidates.join(', ')}.`,
    );
  }

  // Only a checkout build has a source tree beside it to be stale against.
  if (fs.existsSync(srcDir) && path.dirname(dir) === path.dirname(srcDir)) {
    const src = newestMtime(srcDir, '.ts');
    const built = newestMtime(dir, '.js');
    if (src > built) {
      warn(
        `warning: ts/dist is older than ts/src (newest source ` +
          `${new Date(src).toISOString()}, newest build output ` +
          `${new Date(built).toISOString()}). Engine-backed tests are running ` +
          'against stale code — run `npm run build` in ts/.',
      );
    }
  }
  return dir;
}

/** vitest globalSetup entry: runs once, before any test file is collected. */
export default function setup(): void {
  checkEnginePrecondition();
}
