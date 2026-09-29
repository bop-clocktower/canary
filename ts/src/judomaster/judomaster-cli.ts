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

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';

import { CliExitError, normalizeUsageExit } from '../cli-common.js';
import { EXIT_ABSTAINED } from '../core/gate-result.js';
import { buildBrief } from '../analysis/judomaster/brief.js';
import { parseTrace } from '../analysis/judomaster/parse.js';
import { renderBrief, renderVerify } from '../analysis/judomaster/render.js';
import { resolveFrames } from '../analysis/judomaster/resolve.js';
import type { RegressionBrief } from '../analysis/judomaster/types.js';
import {
  classifyRun,
  containedInGenerated,
  inferFramework,
  type VerifyResult,
} from '../analysis/judomaster/verify.js';
import type { ExecuteResult } from '../core/executor.js';
import type { MainDeps } from '../main-deps.js';

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

interface VerifyOpts {
  brief?: string;
  expect?: string;
  framework?: string;
  timeout: string;
  root?: string;
  json?: boolean;
}

type Signature = RegressionBrief['signature'];

const COULD_NOT_REPRODUCE = 'unverified \u2014 could not reproduce';

function readBrief(deps: MainDeps, file: string): RegressionBrief {
  let parsed: Partial<RegressionBrief> | null = null;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    usage(deps, `cannot read ${file} as JSON`);
  }
  if (
    parsed?.schema !== 'canary-judomaster-brief/1' ||
    typeof parsed.signature?.text !== 'string'
  ) {
    usage(deps, `${file} is not a canary-judomaster brief`);
  }
  return parsed as RegressionBrief;
}

/** `--expect` wins over the brief's signature; neither gives null (D5). */
function loadSignature(
  opts: VerifyOpts,
  brief: RegressionBrief | null,
): Signature | null {
  if (opts.expect !== undefined) return { text: opts.expect, kind: 'message' };
  return brief?.signature ?? null;
}

function pickFramework(
  opts: VerifyOpts,
  test: string,
  brief: RegressionBrief | null,
): string | null {
  return opts.framework ?? inferFramework(test) ?? brief?.framework ?? null;
}

function parseTimeout(deps: MainDeps, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    usage(deps, `--timeout must be a positive integer (seconds), got "${raw}"`);
  }
  return n;
}

/** Run the test; an executor that throws (unknown framework) is a reason, not a crash. */
function execSafely(
  deps: MainDeps,
  test: string,
  framework: string,
  timeout: number,
): ExecuteResult | string {
  try {
    return deps.makeExecutor().execute(test, framework, timeout);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function couldNotReproduce(reason: string): VerifyResult {
  return {
    verdict: 'unverified',
    label: COULD_NOT_REPRODUCE,
    vacuity: false,
    reason,
  };
}

function exitFor(result: VerifyResult): number {
  if (result.verdict === 'reproduced') return 0;
  return result.verdict === 'unverified' ? EXIT_ABSTAINED : 1;
}

function containedTest(deps: MainDeps, root: string, test: string): string {
  const real = containedInGenerated(root, test);
  if (real === null) {
    usage(
      deps,
      `${test} is not a file under ${resolve(root, 'tests/generated')}/; verify only runs generated tests`,
    );
  }
  return real;
}

function gradeRun(
  deps: MainDeps,
  real: string,
  framework: string | null,
  timeout: number,
  signature: Signature | null,
): VerifyResult {
  if (framework === null) {
    return couldNotReproduce(
      `no framework known for ${real}; pass --framework`,
    );
  }
  const exec = execSafely(deps, real, framework, timeout);
  if (typeof exec === 'string') return couldNotReproduce(exec);
  return classifyRun(exec, signature, framework);
}

function runVerify(deps: MainDeps, test: string, opts: VerifyOpts): void {
  const root = opts.root ?? deps.cwd();
  const timeout = parseTimeout(deps, opts.timeout);
  const brief = opts.brief === undefined ? null : readBrief(deps, opts.brief);
  const real = containedTest(deps, root, resolve(deps.cwd(), test));
  const framework = pickFramework(opts, real, brief);
  const signature = loadSignature(opts, brief);
  const result = gradeRun(deps, real, framework, timeout, signature);
  const payload = {
    schema: 'canary-judomaster-verify/1',
    ...result,
    test: real,
    framework,
    signature,
  };
  deps.out(
    opts.json
      ? JSON.stringify(payload, null, 2)
      : renderVerify(result).trimEnd(),
  );
  const code = exitFor(result);
  if (code !== 0) throw new CliExitError(code);
}

function buildVerifyCommand(deps: MainDeps): Command {
  return new Command('verify')
    .description(
      'Run a generated regression test and grade it (0 reproduced, 1 not-reproduced or failed-other-reason, 3 unverified, 2 usage).',
    )
    .argument('<test>', 'test file under <root>/tests/generated/')
    .option(
      '--brief <file>',
      'Brief JSON (from brief --json-out) supplying the signature.',
    )
    .option(
      '--expect <text>',
      'Signature text to confirm against (overrides --brief).',
    )
    .option(
      '--framework <name>',
      'Framework override (default: inferred from the extension).',
    )
    .option('--timeout <seconds>', 'Run timeout in seconds.', '60')
    .option('--root <dir>', 'Repository root (default: cwd).')
    .option('--json', 'Print the verify result as JSON.')
    .exitOverride(normalizeUsageExit)
    .action((test: string, opts: VerifyOpts) => runVerify(deps, test, opts));
}

export function buildJudomasterCommand(deps: MainDeps): Command {
  const command = new Command('judomaster').description(
    'Turn a stack trace into a regression brief, then grade the generated test by running it; a pass is never success.',
  );
  command.addCommand(buildBriefCommand(deps));
  command.addCommand(buildVerifyCommand(deps));
  return command;
}
