/**
 * `canary judomaster`: stack trace to a regression test that was watched
 * failing (#614).
 *
 * Two deterministic subcommands with test authoring composed between them by
 * the canary-judomaster skill (D1): `brief` turns a pasted V8/CPython trace
 * into a regression brief, and `verify` grades the generated test by running
 * it. A pass is never reported as success. No LLM call, no network.
 *
 * Lives in its own folder, not beside the engine, for the reason
 * `manhunter/manhunter-cli.ts` does (D8): filename binds the `cli` layer, and a
 * top-level `ts/src` file would grow that module's file count.
 */

import { Command } from 'commander';

import type { MainDeps } from '../main-deps.js';

export function buildJudomasterCommand(_deps: MainDeps): Command {
  return new Command('judomaster').description(
    'Turn a stack trace into a regression brief, then grade the generated test by running it; a pass is never success.',
  );
}
