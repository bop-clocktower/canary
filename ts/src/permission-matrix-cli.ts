/**
 * `canary permission-matrix <model.yaml>` (#857).
 *
 * Writes the generated Playwright suite even when cells are undeclared (as
 * `test.fixme`, so they are counted), then exits 3: a matrix with holes cannot
 * verify the boundary it describes, and must not read as a clean generation.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { Command } from 'commander';
import pc from 'picocolors';

import { CliExitError, jsonIndent2 } from './cli-common.js';
import { EXIT_ABSTAINED } from './core/gate-result.js';
import {
  expandMatrix,
  parseMatrix,
  probedCells,
  renderPlaywright,
  type Cell,
  type MatrixModel,
} from './core/permission-matrix.js';
import { WARN, type MainDeps } from './main-deps.js';

interface Opts {
  out: string;
  json?: boolean;
}

function writeSuite(
  parsed: MatrixModel,
  cells: Cell[],
  undeclared: string[],
  opts: Opts,
  deps: MainDeps,
): void {
  writeFileSync(
    opts.out,
    renderPlaywright(cells, parsed.existenceProbes),
    'utf-8',
  );
  const cross = cells.filter((c) => c.actingTenant !== c.targetTenant).length;
  const probes = probedCells(cells, parsed.existenceProbes).length;
  deps.out(
    `Wrote ${cells.length} cell test(s)` +
      (probes > 0 ? ` + ${probes} existence probe(s)` : '') +
      ` to ${opts.out} ` +
      pc.dim(`(${cross} cross-tenant)`),
  );
  if (undeclared.length === 0) return;
  deps.out(
    pc.bold(
      pc.yellow(
        `${WARN} ${undeclared.length} UNDECLARED cell(s) -- emitted as ` +
          'test.fixme; this matrix cannot verify them:',
      ),
    ),
  );
  for (const u of undeclared) deps.out(`  - ${u}`);
}

export function buildPermissionMatrixCommand(deps: MainDeps): Command {
  return new Command('permission-matrix')
    .description(
      'Generate server-direct authz tests from a declared role x endpoint ' +
        'grid, across every acting x target tenant. Undeclared cells exit 3.',
    )
    .argument('<model>', 'YAML model: roles, tenants, endpoints grid')
    .option(
      '--out <file>',
      'where to write the Playwright suite',
      'permission-matrix.spec.ts',
    )
    .option('--json', 'Print the expanded cells as JSON instead of writing.')
    .action((model: string, opts: Opts) => {
      const parsed = parseMatrix(readFileSync(model, 'utf-8'));
      const { cells, undeclared } = expandMatrix(parsed);
      if (opts.json) {
        const { existenceProbes } = parsed;
        deps.out(jsonIndent2({ cells, undeclared, existenceProbes }));
      } else {
        writeSuite(parsed, cells, undeclared, opts, deps);
      }
      if (undeclared.length > 0) throw new CliExitError(EXIT_ABSTAINED);
    });
}
