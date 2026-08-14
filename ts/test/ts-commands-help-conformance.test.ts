/**
 * Conformance test for the two hand-maintained lists that decide whether a
 * `canary` subcommand is *routable* and whether it is *discoverable*.
 *
 * The npm shim (`npm/bin/canary.js`) dispatches on `TS_COMMANDS` in
 * `npm/src/router.ts`: anything listed there is handled natively in the npm
 * package, and everything else is forwarded to the bundled engine. The engine
 * (`ts/src/cli.ts`) is what renders `canary --help`, so a TS-handled command
 * only appears in the command list if someone *also* registered a stub for it
 * there.
 *
 * Nothing asserted that the two agreed. #730 is the instance: `uninstall`
 * shipped in 7.0.0 routable and fully functional, but absent from
 * `canary --help` — so the one place a user looks to discover commands never
 * mentioned it. `overlay` and `doctor` had stubs; `uninstall` did not.
 *
 * This is the class, not the instance: any future TS-handled command can land
 * routable-but-invisible exactly the same way. The list is read out of
 * `router.ts` rather than restated here, because a hardcoded copy would be a
 * third list with the same drift problem.
 *
 * Offline: reads `npm/src/router.ts` and builds the engine's command in-process.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createCanaryCommand } from '../src/cli.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROUTER_SRC = join(REPO_ROOT, 'npm', 'src', 'router.ts');

/**
 * The `TS_COMMANDS` members declared in `npm/src/router.ts`.
 *
 * Read from source rather than imported: `npm/` is a separate CommonJS package
 * with its own tsconfig, and importing across the boundary would break this
 * package's `rootDir`. Parsing keeps `router.ts` the single source of truth,
 * which is the whole point of the test.
 */
function readTsCommands(): string[] {
  const src = readFileSync(ROUTER_SRC, 'utf8');
  const decl = /export const TS_COMMANDS[^=]*=\s*\[([^\]]*)\]/.exec(src);
  if (!decl) {
    throw new Error(
      `could not find the TS_COMMANDS declaration in ${ROUTER_SRC}; ` +
        'the parse, not the CLI, is what broke',
    );
  }
  return [...decl[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

/** Command names commander lists in the engine's top-level `--help`. */
function helpCommandNames(): string[] {
  return createCanaryCommand({ out: () => {}, err: () => {} }).commands.map(
    (c) => c.name(),
  );
}

describe('TS_COMMANDS ↔ engine --help conformance', () => {
  const tsCommands = readTsCommands();

  // A zero-length list would make every assertion below vacuously true: the
  // regex failing to match must read as a broken test, not a passing one.
  it('finds a non-empty TS_COMMANDS list to check against', () => {
    expect(tsCommands.length).toBeGreaterThan(0);
  });

  it.each(tsCommands)(
    'lists the TS-handled command %s in canary --help',
    (name) => {
      expect(helpCommandNames()).toContain(name);
    },
  );

  // The rendered help text is what a user actually reads; the registration
  // above is only the mechanism that puts it there.
  it.each(tsCommands)('renders %s in the help text itself', (name) => {
    const help = createCanaryCommand({
      out: () => {},
      err: () => {},
    }).helpInformation();
    const listed = help
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean);
    expect(listed).toContain(name);
  });
});
