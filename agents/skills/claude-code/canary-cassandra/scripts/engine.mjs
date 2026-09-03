// Engine resolution for the cassandra skill CLI (#755).
//
// WHY THIS SKILL IMPORTS THE ENGINE AND ITS SIBLINGS DO NOT
//
// savant, blackhawk and katana each own their detection outright, so their CLIs
// are self-contained by construction. Cassandra's detection is NOT its own: it
// already lives in `ts/src/core/vacuity-scanner.ts` and is already exercised by
// `canary vacuity-check` and by the promotion gate. That module's docstring
// states the position deliberately -- #605 accepted that `static_linter` and
// `quality_scorer` already overlap and a third half-enforcer would be the real
// defect -- so shipping a second, hand-copied vacuity scanner inside this skill
// would trade #755's asymmetry for a worse one: two detectors that disagree.
//
// So the missing piece was never the detection. It was the `cli:` entry point,
// and this file is what lets one exist without forking the rules.
//
// The engine sits three-plus levels above this script in both layouts canary
// ships, and the lookup is a fixed, ordered list rather than a search: an
// ambiguous resolution would make which rules ran depend on the install.
//
//   repo checkout : <root>/ts/dist/core/...        (after `npm --prefix ts run build`)
//   npm package   : <pkg>/dist/engine/core/...     (staged by npm/scripts/build-engine.mjs)
//
// A failure to resolve is reported as a failure. It is never absorbed into a
// clean scan -- "the detector could not load" and "the detector found nothing"
// must not print the same thing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// scripts -> canary-cassandra -> claude-code -> skills -> agents -> <root>
const ROOT = path.resolve(HERE, '..', '..', '..', '..', '..');

/** Candidate engine directories, highest priority first. */
export function engineCandidates(root = ROOT, env = process.env) {
  const candidates = [];
  // An explicit override exists for overlay installs, where the skill is
  // deployed away from the engine that owns its rules.
  if (env.CANARY_ENGINE_DIR)
    candidates.push(path.resolve(env.CANARY_ENGINE_DIR));
  candidates.push(path.join(root, 'ts', 'dist'));
  candidates.push(path.join(root, 'dist', 'engine'));
  return candidates;
}

const MODULES = [
  ['core', 'vacuity-scanner.js'],
  ['core', 'test-files.js'],
  ['core', 'gate-result.js'],
];

/** The first candidate directory holding every module we need, or null. */
export function resolveEngineDir(candidates = engineCandidates()) {
  for (const dir of candidates) {
    if (MODULES.every((parts) => fs.existsSync(path.join(dir, ...parts)))) {
      return dir;
    }
  }
  return null;
}

/**
 * Load the engine halves this CLI delegates to.
 *
 * @returns `{ ok: true, ... }` on success, or `{ ok: false, error }` naming
 *   every directory that was tried -- a zero-denominator report of its own.
 */
export async function loadEngine(candidates = engineCandidates()) {
  const dir = resolveEngineDir(candidates);
  if (dir === null) {
    return {
      ok: false,
      error:
        'the vacuity engine could not be located, so nothing was scanned. ' +
        `Tried: ${candidates.join(', ')}. In a Canary checkout run ` +
        '`npm --prefix ts run build`; otherwise reinstall canary-test-cli, or ' +
        'set CANARY_ENGINE_DIR to the directory holding core/.',
    };
  }
  const load = (parts) => import(pathToFileURL(path.join(dir, ...parts)).href);
  const [vacuity, testFiles, gate] = await Promise.all(MODULES.map(load));
  return {
    ok: true,
    dir,
    scanVacuity: vacuity.scanVacuity,
    collectTestFiles: testFiles.collectTestFiles,
    isDir: testFiles.isDir,
    SCANNABLE_DESC: testFiles.SCANNABLE_DESC,
    gateOutcome: gate.gateOutcome,
    EXIT_ABSTAINED: gate.EXIT_ABSTAINED,
  };
}
