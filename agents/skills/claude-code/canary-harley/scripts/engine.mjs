/**
 * canary-harley -- locate the built engine and load `extractFileFunctions`.
 *
 * The function list is the engine's, not this skill's: it is the extractor
 * behind `analyze_file`'s `file_functions`, so there is one definition of
 * "the functions in this file". The lookup is a fixed, ordered list, never a
 * search, so which extractor ran cannot depend on the install.
 *
 *   repo checkout : <root>/ts/dist/mcp-server.js   (npm --prefix ts run build)
 *   npm package   : <pkg>/dist/engine/mcp-server.js
 *
 * A failure to resolve is reported as a failure. "The extractor could not
 * load" and "the file holds no functions" must not print the same thing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// scripts -> canary-harley -> claude-code -> skills -> agents -> <root>
const ROOT = path.resolve(HERE, '..', '..', '..', '..', '..');

const MODULE = 'mcp-server.js';

const FIX =
  'In a Canary checkout run `npm --prefix ts run build`; otherwise ' +
  'reinstall canary-test-cli, or set CANARY_ENGINE_DIR to the directory ' +
  `holding ${MODULE}.`;

/**
 * @param {string} [root] the checkout or package root
 * @param {Record<string, string | undefined>} [env]
 * @returns {string[]} candidate engine directories, highest priority first
 */
export function engineCandidates(root = ROOT, env = process.env) {
  // The override exists for overlay installs, where the skill is deployed
  // away from the engine it reads.
  const override = env.CANARY_ENGINE_DIR
    ? [path.resolve(env.CANARY_ENGINE_DIR)]
    : [];
  return [
    ...override,
    path.join(root, 'ts', 'dist'),
    path.join(root, 'dist', 'engine'),
  ];
}

const failure = (error) => ({ ok: false, error });

/** The engine module, or null when importing it throws. */
async function importEngine(dir) {
  try {
    return await import(pathToFileURL(path.join(dir, MODULE)).href);
  } catch {
    return null;
  }
}

/**
 * @param {string[]} [candidates] directories to try, in order
 * @returns {Promise<{ ok: boolean, dir?: string, error?: string,
 *   extractFileFunctions?: (file: string) => string[] }>} on failure `error`
 *   names every directory tried, or the export the module lacks
 */
export async function loadEngine(candidates = engineCandidates()) {
  const dir = candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, MODULE)),
  );
  if (dir === undefined) {
    return failure(
      'the engine could not be located, so no function list was read. ' +
        `Tried: ${candidates.join(', ')}. ${FIX}`,
    );
  }
  const engine = await importEngine(dir);
  if (engine === null) {
    return failure(
      `the engine at ${dir} could not be loaded, so no function list was ` +
        `read. ${FIX}`,
    );
  }
  if (typeof engine.extractFileFunctions !== 'function') {
    return failure(
      `the engine at ${dir} does not export extractFileFunctions, so no ` +
        `function list was read. ${FIX}`,
    );
  }
  return { ok: true, dir, extractFileFunctions: engine.extractFileFunctions };
}
