/**
 * `audit` sub-app registry for `canary` (#988). History-driven audits: closure, rewind, test order.
 *
 * Rule: a new sub-app joins the domain registry it belongs to, appended where
 * it should appear in help. Each registry is capped at 12 imports by
 * ts/test/cli-command-registry.test.ts (threshold is 15); a full registry means
 * opening a new domain folder under ts/src/commands/, never growing this one.
 */

import type { Command } from 'commander';

import { buildBatwomanCommand } from '../../batwoman-cli.js';
import { buildRewindCommand } from '../../rewind/rewind-cli.js';
import { buildOrderCommand } from '../../order/order-cli.js';
import type { MainDeps } from '../../main-deps.js';

export const AUDIT_COMMANDS: ReadonlyArray<(deps: MainDeps) => Command> = [
  (deps) => buildBatwomanCommand(deps),
  (deps) => buildRewindCommand(deps),
  (deps) => buildOrderCommand(deps),
];
