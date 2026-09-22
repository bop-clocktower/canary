/**
 * `engine` sub-app registry for `canary` (#988). Run-history and guardian engines, mounted with the main out/err sinks.
 *
 * Rule: a new sub-app joins the domain registry it belongs to, appended where
 * it should appear in help. Each registry is capped at 12 imports by
 * ts/test/cli-command-registry.test.ts (threshold is 15); a full registry means
 * opening a new domain folder under ts/src/commands/, never growing this one.
 */

import type { Command } from 'commander';

import { createHistoryCommand } from '../../history/cli.js';
import { registerTrimCommand } from '../../history/retention/command.js';
import { createAnalyzeCommand } from '../../analysis/cli.js';
import { createGuardianCommand } from '../../guardian/cli.js';
import type { MainDeps } from '../../main-deps.js';

export const ENGINE_COMMANDS: ReadonlyArray<(deps: MainDeps) => Command> = [
  // `history trim` (#1024) is registered here rather than inside
  // `history/cli.ts`: that module sits exactly on the arch module-size ceiling
  // for `ts/src/history` and on the 15-import perf threshold, and this registry
  // is the seam #988 added so a new subcommand does not have to tax it.
  (deps) => {
    const history = createHistoryCommand({ out: deps.out, err: deps.err });
    registerTrimCommand(history, {
      out: deps.out,
      err: deps.err,
      env: process.env,
    });
    return history;
  },
  (deps) => createAnalyzeCommand({ out: deps.out, err: deps.err }),
  (deps) => createGuardianCommand({ out: deps.out, err: deps.err }),
];
