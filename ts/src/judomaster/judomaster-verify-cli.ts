/**
 * `canary judomaster verify` (#614): run one generated regression test and
 * grade it (D2-D6, D9). Split from `judomaster-cli.ts` to keep each file under
 * the perf file-length threshold; the filename binds the `cli` layer.
 *
 * The runner is the framework's registry command, spawned with cwd set to
 * the realpath of `--root` (default: the current directory) so it finds
 * the project's config, and with `npx --no` in place of `npx --yes`: a
 * runner the root does not have installed is reported as unverified,
 * never downloaded (#1138).
 */

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Command } from 'commander';

import { CliExitError, normalizeUsageExit } from '../cli-common.js';
import { EXIT_ABSTAINED } from '../core/gate-result.js';
import type { ExecuteResult } from '../core/executor.js';
import { renderVerify } from '../analysis/judomaster/render.js';
import { mockedSuspectWarnings } from '../analysis/judomaster/resolve.js';
import type { RegressionBrief } from '../analysis/judomaster/types.js';
import {
  classifyRun,
  containedInGenerated,
  inferFramework,
  type VerifyResult,
} from '../analysis/judomaster/verify.js';
import type { MainDeps } from '../main-deps.js';

const EXIT_USAGE = 2;

function usage(deps: MainDeps, message: string): never {
  deps.err(`judomaster: ${message}`);
  throw new CliExitError(EXIT_USAGE);
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

/** Shortest `--expect` accepted: with no error type to anchor it, a short
 * string matches nearly any output. */
const MIN_EXPECT = 8;

/** `--expect` wins over the brief's signature; neither gives null (D5). */
function loadSignature(
  deps: MainDeps,
  opts: VerifyOpts,
  brief: RegressionBrief | null,
): Signature | null {
  if (opts.expect === undefined) return brief?.signature ?? null;
  const text = opts.expect.trim();
  if (text.length < MIN_EXPECT) {
    usage(
      deps,
      `--expect needs at least ${MIN_EXPECT} characters of the error message; use --brief for a short, type-anchored signature`,
    );
  }
  return { text, kind: 'message' };
}

function pickFramework(
  opts: VerifyOpts,
  test: string,
  brief: RegressionBrief | null,
): string | null {
  // The brief knows the trace's runtime; an extension such as `.spec.ts` is
  // ambiguous (vitest and playwright both use it), so it comes last.
  return opts.framework ?? brief?.framework ?? inferFramework(test);
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
  cwd: string,
): ExecuteResult | string {
  try {
    return deps
      .makeExecutor()
      .execute(test, framework, timeout, { cwd, fetch: false });
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

/** Largest sibling file read when looking for a quoted signature. */
const MAX_SOURCE_BYTES = 256 * 1024;

/**
 * The test plus the other files beside it under `tests/generated/`: a helper
 * or fixture the test imports can quote the incident error just as well as
 * the test itself can.
 */
function generatedSources(test: string): string {
  const dir = dirname(test);
  const siblings = readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => {
      const st = statSync(path);
      return st.isFile() && st.size <= MAX_SOURCE_BYTES;
    });
  return siblings.map((path) => readFileSync(path, 'utf-8')).join('\n');
}

function gradeRun(
  deps: MainDeps,
  real: string,
  framework: string | null,
  timeout: number,
  signature: Signature | null,
  rootReal: string,
): VerifyResult {
  if (framework === null) {
    return couldNotReproduce(
      `no framework known for ${real}; pass --framework`,
    );
  }
  const exec = execSafely(deps, real, framework, timeout, rootReal);
  if (typeof exec === 'string') return couldNotReproduce(exec);
  return classifyRun(exec, signature, framework, generatedSources(real));
}

/**
 * C6 (#1138): a warning, never a verdict change. Reads the test's own
 * source only; needs the brief's suspect, so without --brief it is skipped.
 */
function withMockWarnings(
  result: VerifyResult,
  brief: RegressionBrief | null,
  real: string,
  rootReal: string,
): VerifyResult {
  const suspect = brief?.suspect?.path;
  if (suspect === undefined) return result;
  const dir = relative(rootReal, dirname(real)).split(sep).join('/');
  const source = readFileSync(real, 'utf-8');
  const warnings = mockedSuspectWarnings(source, dir, suspect);
  return warnings.length === 0 ? result : { ...result, warnings };
}

function runVerify(deps: MainDeps, test: string, opts: VerifyOpts): void {
  const root = opts.root ?? deps.cwd();
  const timeout = parseTimeout(deps, opts.timeout);
  const brief = opts.brief === undefined ? null : readBrief(deps, opts.brief);
  const real = containedTest(deps, root, resolve(deps.cwd(), test));
  const rootReal = realpathSync(root);
  const framework = pickFramework(opts, real, brief);
  const signature = loadSignature(deps, opts, brief);
  const result = withMockWarnings(
    gradeRun(deps, real, framework, timeout, signature, rootReal),
    brief,
    real,
    rootReal,
  );
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

export function buildVerifyCommand(deps: MainDeps): Command {
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
