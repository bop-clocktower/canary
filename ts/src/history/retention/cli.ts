/**
 * The `canary history trim` subcommand (#1024).
 *
 * Mounted from `../../commands/engine/cli.ts` (the #988 domain registry), not
 * from `../cli.ts`: that module sits exactly on the arch module-size ceiling
 * for `ts/src/history` and on the 15-import perf threshold, and the registry is
 * the seam added so a new subcommand does not have to tax it.
 *
 * Named `cli.ts` on purpose. Layer binding is by filename (`ts/src/**\/*cli*.ts`
 * is the `cli` layer, first match wins), and this module imports `cli-common`;
 * as `command.ts` it bound to the `history` layer and `check-deps` correctly
 * called that a history -> cli violation.
 */

import { Command, InvalidArgumentError, Option } from 'commander';
import pc from 'picocolors';

import {
  CliExitError,
  jsonIndent2,
  normalizeUsageExit,
} from '../../cli-common.js';
import { trimStoreToNewest } from './trim.js';

const EM_DASH = '\u{2014}';
const DEFAULT_HISTORY_FILE = 'test-results/reports/history-v2.jsonl';

interface TrimOptions {
  keep: number;
  path?: string;
  dbUrl?: string;
  json?: boolean;
}

/** The sinks + env this command needs (a narrowing of `HistoryDeps`). */
interface TrimDeps {
  out(s: string): void;
  err(s: string): void;
  env: NodeJS.ProcessEnv;
}

/**
 * A whole count of runs, >= 1 -- the same rule `--window` adopted in #673.
 * A bare `parseInt` would let `--keep 0` through, and a keep of 0 empties the
 * store: the widest possible deletion, under a flag that reads like a bound.
 */
function parseKeep(raw: string): number {
  if (!/^\d+$/.test(raw.trim()) || Number.parseInt(raw, 10) < 1) {
    throw new InvalidArgumentError(
      `--keep takes a whole number of RUNS, at least 1; got "${raw}".`,
    );
  }
  return Number.parseInt(raw, 10);
}

/**
 * Trim a LOCAL store.
 *
 * Refuses rather than no-ops when a remote store is configured: a caller who
 * asked for a bounded store and got a silent exit 0 over an untouched remote
 * would have a false green, not a trim.
 */
function trimCmd(opts: TrimOptions, deps: TrimDeps): void {
  const remote = opts.dbUrl ?? deps.env['CANARY_HISTORY_DB_URL'];
  if (remote) {
    deps.err(
      `${pc.red('Refusing to trim:')} a db-url is configured, and \`trim\` ` +
        `only bounds a local NDJSON store. Unset CANARY_HISTORY_DB_URL (or ` +
        `drop --db-url) to trim the local store; remote retention is the ` +
        `database's to manage.`,
    );
    throw new CliExitError(1);
  }

  const storePath = opts.path ?? DEFAULT_HISTORY_FILE;
  const result = trimStoreToNewest(storePath, opts.keep);

  if (opts.json) {
    deps.out(jsonIndent2({ ...result, keep: opts.keep, path: storePath }));
    return;
  }
  if (result.removed === 0) {
    deps.out(
      `${storePath}: ${result.before} run(s), within the ${opts.keep}-run ` +
        `retention ${EM_DASH} nothing removed.`,
    );
    return;
  }
  deps.out(
    `${storePath}: trimmed ${result.before} run(s) to ${result.after} ` +
      `${EM_DASH} removed the ${result.removed} oldest.`,
  );
}

/** Attach `trim` to the `history` command. */
export function registerTrimCommand(program: Command, deps: TrimDeps): void {
  const trim = program
    .command('trim')
    .description(
      'Drop all but the newest N runs from a local history store (retention).',
    )
    .addOption(
      new Option('--keep <n>', 'How many of the newest runs to keep.')
        .argParser(parseKeep)
        .makeOptionMandatory(),
    )
    .option(
      '--path <store>',
      `Local NDJSON store to trim (default: ${DEFAULT_HISTORY_FILE}).`,
    )
    .addOption(new Option('--db-url <url>').env('CANARY_HISTORY_DB_URL'))
    .option('--json')
    .action((opts: TrimOptions) => {
      trimCmd(opts, deps);
    });
  // `createHistoryCommand` applies this to the subcommands it builds itself;
  // one registered from outside has to opt in, or a usage error here would
  // exit 1 while every sibling exits 2.
  trim.exitOverride(normalizeUsageExit);
}
