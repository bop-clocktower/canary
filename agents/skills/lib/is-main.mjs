// Shared "is this module the process entry point?" check for every skill
// cli.mjs (#1182).
//
// The family used `import.meta.url === \`file://${process.argv[1]}\``, which is
// false whenever the invoked path differs from the resolved URL: through a
// symlink (macOS /tmp -> /private/tmp, a symlinked checkout or runner temp
// dir), and for any path that needs URL-encoding (spaces, `%`, non-ASCII). The
// CLI then printed nothing and exited 0, which a caller reads as "scanned, no
// findings". Comparing resolved real paths is immune to both.

import { realpathSync } from 'node:fs';
import process from 'node:process';
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
