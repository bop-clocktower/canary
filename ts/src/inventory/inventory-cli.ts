/**
 * `canary inventory`: writes `.canary/test-inventory.json` (#957), the input
 * `canary ci-ready` scores coverage-depth, assertion-quality and critical-paths
 * from. Schema: docs/guides/test-inventory.md.
 *
 * Exit codes follow the CLI-wide gate contract:
 *   - 0: the inventory was written.
 *   - 3 (EXIT_ABSTAINED): no test was found, so NOTHING is written. An empty
 *     inventory on disk would let a later ci-ready run mistake "listed zero
 *     tests" for a real input.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Command } from 'commander';

import { CliExitError, jsonIndent2 } from '../cli-common.js';
import { EXIT_ABSTAINED } from '../core/gate-result.js';
import { SCANNABLE_DESC, collectTestFiles } from '../core/test-files.js';
import { buildInventory, inventoryTestCount } from '../core/test-inventory.js';
import type { MainDeps } from '../main-deps.js';

interface InventoryOpts {
  root?: string;
  json?: boolean;
}

function runInventory(
  testDir: string | undefined,
  opts: InventoryOpts,
  deps: MainDeps,
): void {
  const root = resolve(opts.root ?? deps.cwd());
  const dir = testDir === undefined ? root : resolve(root, testDir);
  const inv = buildInventory(
    root,
    collectTestFiles(dir),
    new Date().toISOString(),
  );
  const tests = inventoryTestCount(inv);
  if (tests === 0) {
    deps.out(
      `Abstained: 0 tests found under ${dir} (looked for ${SCANNABLE_DESC}); no inventory written.`,
    );
    throw new CliExitError(EXIT_ABSTAINED);
  }
  const out = join(root, '.canary', 'test-inventory.json');
  mkdirSync(join(root, '.canary'), { recursive: true });
  writeFileSync(out, jsonIndent2(inv) + '\n', 'utf-8');
  if (opts.json === true) {
    deps.out(jsonIndent2(inv));
    return;
  }
  const skipped =
    inv.skipped.length > 0 ? ` (${inv.skipped.length} skipped)` : '';
  deps.out(
    `Wrote ${out}: ${tests} test(s) in ${inv.files.length} file(s)${skipped}.`,
  );
}

export function buildInventoryCommand(deps: MainDeps): Command {
  return new Command('inventory')
    .description(
      'Write .canary/test-inventory.json (per-test assertion depth and import targets) for canary ci-ready.',
    )
    .argument('[testDir]', 'Directory to walk for tests (default: --root).')
    .option('--root <dir>', 'Repository root (default: current directory).')
    .option('--json', 'Also print the written inventory as JSON.')
    .action((testDir: string | undefined, opts: InventoryOpts) => {
      runInventory(testDir, opts, deps);
    });
}
