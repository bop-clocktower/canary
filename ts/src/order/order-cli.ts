/**
 * `canary order --suite <s> [files...]` (#460 phase 2b): print an order plan
 * that runs the likeliest-to-fail test files first. The ranking lives in
 * `analysis/order/rank.ts`; this module gathers its inputs (the file list, the
 * history store, the diff and the test inventory) and wires commander.
 *
 * Exit codes: 0 a plan was emitted (any mode), 2 unreadable input or a plan
 * that is not a permutation of its input, 3 abstained because no test files
 * were given (an empty plan is not an order).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { Command, Option } from 'commander';

import {
  assertPermutation,
  buildOrderPlan,
  type OrderPlan,
} from '../analysis/order/rank.js';
import { readInventoryIndex } from '../briefing/inputs.js';
import { CliExitError } from '../cli-common.js';
import { makeStore } from '../history/store.js';
import type { MainDeps } from '../main-deps.js';

interface OrderCliOptions {
  suite: string;
  filesFrom?: string;
  base?: string;
  path?: string;
  dbUrl?: string;
  out?: string;
  json?: boolean;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function usage(deps: MainDeps, message: string): never {
  deps.err(message);
  throw new CliExitError(2);
}

/** Input files, repo-relative with `/`, first occurrence kept. */
function inputFiles(
  args: string[],
  opts: OrderCliOptions,
  cwd: string,
  top: string,
  deps: MainDeps,
): string[] {
  let raw = args;
  if (opts.filesFrom !== undefined) {
    try {
      const text = readFileSync(
        opts.filesFrom === '-' ? 0 : opts.filesFrom,
        'utf-8',
      );
      raw = [...args, ...text.split('\n').map((l) => l.trim())];
    } catch (err) {
      usage(deps, `cannot read --files-from: ${(err as Error).message}`);
    }
  }
  const keyed = raw
    .filter((f) => f !== '')
    .map((f) => {
      const abs = isAbsolute(f) ? f : resolve(cwd, f);
      return relative(top, abs).split(sep).join('/');
    });
  return [...new Set(keyed)];
}

/** Paths changed between `base` and HEAD, or null with no `--base`. */
function changedFiles(
  top: string,
  base: string | undefined,
  deps: MainDeps,
): string[] | null {
  if (base === undefined) return null;
  // Reaches git as an argument; a leading '-' would be read as an option.
  if (base.startsWith('-')) usage(deps, `--base '${base}' is not a ref`);
  if (git(top, ['rev-parse', '--verify', '-q', `${base}^{commit}`]) === null) {
    usage(deps, `--base '${base}' does not resolve to a commit`);
  }
  const out = git(top, ['diff', '--name-only', `${base}...HEAD`]);
  if (out === null) usage(deps, `git diff against '${base}' failed`);
  return out.split('\n').filter((l) => l !== '');
}

function renderText(plan: OrderPlan): string {
  const diff =
    plan.changedFiles === null ? 'no diff' : `${plan.changedFiles} changed`;
  const lines = [
    `mode: ${plan.mode} (${plan.modeReason})`,
    `history runs: ${plan.historyRuns} · ${diff} · ${plan.unranked.length} of ${plan.entries.length} unranked`,
  ];
  plan.entries.forEach((e, i) => {
    const why = e.reasons.length > 0 ? `  <- ${e.reasons.join('; ')}` : '';
    lines.push(`${i + 1}. ${e.test_file}${why}`);
  });
  return lines.join('\n');
}

async function orderCmd(
  args: string[],
  opts: OrderCliOptions,
  deps: MainDeps,
): Promise<void> {
  const cwd = deps.cwd();
  const top = git(cwd, ['rev-parse', '--show-toplevel']) ?? cwd;
  const files = inputFiles(args, opts, cwd, top, deps);
  if (files.length === 0) {
    deps.out(
      'Abstained: no test files given. Pass them as arguments or with ' +
        '--files-from; an empty plan is not an order.',
    );
    throw new CliExitError(3);
  }
  const store = makeStore(opts.dbUrl, opts.path);
  if (!store.readAll) {
    deps.err(
      'note: this history backend cannot return runs; history is not used.',
    );
  }
  const plan = buildOrderPlan({
    suite: opts.suite,
    files,
    runs: store.readAll ? await store.readAll() : [],
    changed: changedFiles(top, opts.base, deps),
    imports: readInventoryIndex(top),
  });
  try {
    assertPermutation(files, plan);
  } catch (err) {
    usage(deps, (err as Error).message);
  }
  const json = JSON.stringify(plan, null, 2);
  if (opts.out !== undefined) writeFileSync(opts.out, `${json}\n`, 'utf-8');
  deps.out(opts.json === true ? json : renderText(plan));
}

export function buildOrderCommand(deps: MainDeps): Command {
  return new Command('order')
    .description(
      'Order test files so the likeliest to fail run first (history + diff). Never drops a file.',
    )
    .argument('[files...]', 'Test files in the runner declaration order.')
    .requiredOption(
      '--suite <suite>',
      'Suite name used when recording history.',
    )
    .option(
      '--files-from <path>',
      "Read test files one per line ('-' for stdin).",
    )
    .option(
      '--base <ref>',
      'Diff base; changed files and their importers rank up.',
    )
    .option('--path <store>', 'Local history store to read.')
    .addOption(new Option('--db-url <url>').env('CANARY_HISTORY_DB_URL'))
    .option(
      '--out <file>',
      'Also write the plan JSON here (for a runner adapter).',
    )
    .option('--json')
    .action(async (files: string[], opts: OrderCliOptions) => {
      await orderCmd(files, opts, deps);
    });
}
