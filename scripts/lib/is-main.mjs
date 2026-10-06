// "Is this module the process entry point?" for the repo scripts (#1189).
//
// The scripts compared `import.meta.url` with `pathToFileURL(process.argv[1])`,
// which handles URL-encoding but is false through a symlink: `import.meta.url`
// is always the resolved real path, while argv[1] is whatever path was typed.
// The script then printed nothing and exited 0, which a caller reads as a pass.
// Comparing resolved real paths is immune to both. Same fix as the skill CLIs'
// `agents/skills/lib/is-main.mjs` (#1182); kept separate so `scripts/` takes no
// dependency on the skills tree.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * True when the module at `metaUrl` is the script node was asked to run.
 *
 * @param {string} metaUrl the caller's `import.meta.url`
 * @param {string | undefined} [entry] the invoked script, `process.argv[1]`
 * @returns {boolean}
 */
export function isMain(metaUrl, entry = process.argv[1]) {
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(entry);
  } catch {
    // An entry that does not exist on disk (`node -e`, a REPL) is not this file.
    return false;
  }
}
