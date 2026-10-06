/**
 * `canary judomaster`: stack trace to a regression test that was watched
 * failing (#614).
 *
 * Two deterministic subcommands with test authoring composed between them by
 * the canary-judomaster skill (D1): `brief` turns a pasted V8/CPython trace
 * into a regression brief, and `verify` grades the generated test by running
 * it. A pass is never reported as success. No LLM call. `verify` runs the
 * framework's registry command from `--root` and never downloads a runner
 * (see judomaster-verify-cli.ts).
 *
 * Lives in its own folder, not beside the engine, for the reason
 * `manhunter/manhunter-cli.ts` does (D8): filename binds the `cli` layer, and a
 * top-level `ts/src` file would grow that module's file count.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';

import { CliExitError, normalizeUsageExit } from '../cli-common.js';
import { EXIT_ABSTAINED } from '../core/gate-result.js';
import { buildBrief } from '../analysis/judomaster/brief.js';
import { parseTrace } from '../analysis/judomaster/parse.js';
import { renderBrief } from '../analysis/judomaster/render.js';
import { resolveFrames } from '../analysis/judomaster/resolve.js';
import type { MainDeps } from '../main-deps.js';
import { buildVerifyCommand } from './judomaster-verify-cli.js';

const EXIT_USAGE = 2;

interface BriefOpts {
  root?: string;
  json?: boolean;
  jsonOut?: string;
}

function usage(deps: MainDeps, message: string): never {
  deps.err(`judomaster: ${message}`);
  throw new CliExitError(EXIT_USAGE);
}

function abstain(deps: MainDeps, message: string): never {
  deps.err(`judomaster: ${message}`);
  throw new CliExitError(EXIT_ABSTAINED);
}

/** The trace from a file, or from stdin (fd 0) when omitted or `-`. */
function readTrace(deps: MainDeps, trace: string | undefined): string {
  const fromStdin = trace === undefined || trace === '-';
  try {
    return readFileSync(fromStdin ? 0 : trace, 'utf-8');
  } catch {
    usage(deps, `cannot read ${fromStdin ? 'stdin' : trace}`);
  }
}

function runBrief(
  deps: MainDeps,
  trace: string | undefined,
  opts: BriefOpts,
): void {
  const root = opts.root ?? deps.cwd();
  if (!existsSync(root)) usage(deps, `--root ${root} does not exist`);
  const parsed = parseTrace(readTrace(deps, trace));
  if (parsed === null) {
    abstain(
      deps,
      'no V8 or CPython frames recognised (need an error line and at least one frame); other trace formats are not supported',
    );
  }
  const brief = buildBrief(parsed, resolveFrames(parsed.frames, root));
  if (brief.suspect === null) {
    const tried = brief.frames.map((f) => `${f.file}:${f.line} (${f.status})`);
    abstain(deps, `no frame resolves inside ${root}: ${tried.join(', ')}`);
  }
  const json = `${JSON.stringify(brief, null, 2)}\n`;
  if (opts.jsonOut !== undefined) writeFileSync(opts.jsonOut, json);
  deps.out(opts.json ? json.trimEnd() : renderBrief(brief).trimEnd());
}

function buildBriefCommand(deps: MainDeps): Command {
  return new Command('brief')
    .description(
      'Parse a V8 or CPython stack trace and emit a regression brief (0 emitted, 3 no trace or no in-repo frame, 2 unreadable input).',
    )
    .argument('[trace]', 'trace file; stdin when omitted or "-"')
    .option(
      '--root <dir>',
      'Repository root frames resolve against (default: cwd).',
    )
    .option('--json', 'Print the brief as JSON instead of markdown.')
    .option('--json-out <file>', 'Also write the JSON brief here.')
    .exitOverride(normalizeUsageExit)
    .action((trace: string | undefined, opts: BriefOpts) =>
      runBrief(deps, trace, opts),
    );
}

export function buildJudomasterCommand(deps: MainDeps): Command {
  const command = new Command('judomaster').description(
    'Turn a stack trace into a regression brief, then grade the generated test by running it; a pass is never success.',
  );
  command.addCommand(buildBriefCommand(deps));
  command.addCommand(buildVerifyCommand(deps));
  return command;
}
