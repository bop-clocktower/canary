/**
 * The sub-app registry array for `canary` (#988).
 *
 * `ts/src/cli.ts` loops over {@link COMMANDS}; it never imports a sub-app
 * builder. Builders live in per-domain registries (`engine`, `project`,
 * `audit`, `readiness`), so a new subcommand adds one import to ONE domain
 * registry, and this file gains an import only when a new domain opens. That
 * keeps every module structurally under the perf gate's 15-import threshold:
 * ts/test/cli-command-registry.test.ts caps each registry module at 12.
 *
 * Files are named `cli.ts` on purpose: they sit in the `cli` arch layer
 * (`ts/src/**\/*cli*.ts`) and under the reviewed `coupling` /
 * `ts/src/**\/cli.ts` allowance, since a registry is coupling-ratio 1.00 by
 * definition. Order of the concatenation is help/registration order.
 */

import type { Command } from 'commander';

import { AUDIT_COMMANDS } from './audit/cli.js';
import { ENGINE_COMMANDS } from './engine/cli.js';
import { PROJECT_COMMANDS } from './project/cli.js';
import { READINESS_COMMANDS } from './readiness/cli.js';
import type { MainDeps } from '../main-deps.js';

export const COMMANDS: ReadonlyArray<(deps: MainDeps) => Command> = [
  ...ENGINE_COMMANDS,
  ...PROJECT_COMMANDS,
  ...AUDIT_COMMANDS,
  ...READINESS_COMMANDS,
];
