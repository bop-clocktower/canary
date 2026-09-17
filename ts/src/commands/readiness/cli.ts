/**
 * `readiness` sub-app registry for `canary` (#988). Suite readiness, data and briefing tools.
 *
 * Rule: a new sub-app joins the domain registry it belongs to, appended where
 * it should appear in help. Each registry is capped at 12 imports by
 * ts/test/cli-command-registry.test.ts (threshold is 15); a full registry means
 * opening a new domain folder under ts/src/commands/, never growing this one.
 */

import type { Command } from 'commander';

import { buildScalingCurveCommand } from '../../scaling-curve-cli.js';
import { buildPermissionMatrixCommand } from '../../permission-matrix-cli.js';
import { buildCiReadyCommand } from '../../ci-ready-cli.js';
import { buildInventoryCommand } from '../../inventory/inventory-cli.js';
import { buildGenDataCommand } from '../../gen-data/gen-data-cli.js';
import { buildBriefingCommand } from '../../briefing/briefing-cli.js';
import { buildAdoptionCommand } from '../../adoption/adoption-cli.js';
import type { MainDeps } from '../../main-deps.js';

export const READINESS_COMMANDS: ReadonlyArray<(deps: MainDeps) => Command> = [
  (deps) => buildScalingCurveCommand(deps),
  (deps) => buildPermissionMatrixCommand(deps),
  (deps) => buildCiReadyCommand(deps),
  (deps) => buildInventoryCommand(deps),
  (deps) => buildGenDataCommand(deps),
  (deps) => buildBriefingCommand(deps),
  (deps) => buildAdoptionCommand(deps),
];
