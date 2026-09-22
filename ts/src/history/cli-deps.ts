/**
 * The injected outside-world seams shared by every `canary history` subcommand.
 *
 * Extracted from `cli.ts` for #1074 so the ingest (`ingest/cli.ts`) and
 * reporting (`reporting/cli.ts`) halves can both depend on the deps contract
 * without either importing the command root -- a root that imported its own
 * halves while they imported it back would be a runtime import cycle, not just
 * an ugly one.
 *
 * Named `cli-deps.ts` on purpose: layer binding is by filename
 * (`ts/src/**\/*cli*.ts` is the `cli` layer, first match wins), and this module
 * reaches into `keys/replay-context.ts` for the production `git` seam.
 *
 * `HistoryDeps` stays re-exported from `cli.ts` -- that is where every existing
 * caller and test imports it from, and #1074 is a paydown, not an API change.
 */

import { makeStore as realMakeStore, type AsyncHistoryStore } from './store.js';
import { runGit } from './keys/replay-context.js';

/** Injected outside-world seams (out/err sinks, env, store factory). */
export interface HistoryDeps {
  out(s: string): void;
  err(s: string): void;
  env: NodeJS.ProcessEnv;
  makeStore(dbUrl?: string, ndjsonPath?: string): AsyncHistoryStore;
  /** Run git in the working directory; stdout trimmed, or null on failure. */
  git(args: string[]): string | null;
  cwd(): string;
}

/** Process-backed defaults for production. */
export function defaultHistoryDeps(): HistoryDeps {
  return {
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
    env: process.env,
    makeStore: (dbUrl, ndjsonPath) => realMakeStore(dbUrl, ndjsonPath),
    git: runGit,
    cwd: () => process.cwd(),
  };
}
