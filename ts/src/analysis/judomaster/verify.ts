/**
 * Run classification for canary-judomaster (#614), decisions D2-D5 and D9.
 *
 * A generated regression test is evidence only once it was watched failing
 * for the incident's reason. So the verdict is read off a real run:
 *
 *   - `reproduced`          non-zero exit AND the signature in the output;
 *   - `not-reproduced`      it passed first time -- a vacuity red flag;
 *   - `failed-other-reason` red, but not for the incident's reason (an import
 *                           error, a typo, a missing fixture); unverified;
 *   - `unverified`          the runner could not collect or run it at all.
 *
 * Could-not-run is checked first so a timeout whose partial output happens to
 * contain the signature can never read as a reproduction.
 */

import { realpathSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import type { ExecuteResult } from '../../core/executor.js';
import type { RegressionBrief, VerifyVerdict } from './types.js';

type Signature = RegressionBrief['signature'];

export interface VerifyResult {
  verdict: VerifyVerdict;
  label: string;
  vacuity: boolean;
  reason: string;
  /** Last lines of runner output (ANSI stripped), so a red run shows why. */
  tail?: string[];
}

const ANSI = /\x1b\[[0-9;]*m/g;
const COULD_NOT_REPRODUCE = 'unverified — could not reproduce';
const TAIL_LINES = 15;
/** Runner output that means nothing was collected. */
const NOT_COLLECTED = [
  /No test files found/i,
  /No test suite found/i,
  /No tests found/i,
];
const SPAWN_FAILED = /ENOENT|EACCES|spawn/;
/** pytest: 3 internal error, 4 usage error, 5 no tests collected. */
const PYTEST_NOT_RUN = new Set([3, 4, 5]);

function pytestNotRun(code: number): string | null {
  // Exit 2 is an interrupted session, usually a collection error -- which
  // can be the defect itself firing at import time. It still proves nothing
  // about the test, so it is unverified, but the reason says where to look.
  if (code === 2) {
    return 'pytest exited 2 (interrupted, usually a collection error; if the defect fires at import time, read the output tail)';
  }
  if (PYTEST_NOT_RUN.has(code)) {
    return `pytest exited ${code}: nothing was collected or run`;
  }
  return null;
}

function couldNotRun(exec: ExecuteResult, framework: string): string | null {
  const [code, stdout, stderr] = exec;
  if (code === 124) return 'the run timed out';
  if (code === 127) return 'the runner command was not found';
  // The executor reports a signal death (OOM kill, segfault) as a negative
  // code; whatever partial output it left cannot confirm anything.
  if (code < 0) return `the runner was killed by a signal (${-code})`;
  const pytest = framework === 'pytest' ? pytestNotRun(code) : null;
  if (pytest !== null) return pytest;
  const output = `${stdout}\n${stderr}`;
  if (NOT_COLLECTED.some((re) => re.test(output))) {
    return 'the runner collected no tests';
  }
  if (code !== 0 && stdout === '' && SPAWN_FAILED.test(stderr)) {
    return `the runner could not be spawned: ${stderr.trim()}`;
  }
  return null;
}

function result(
  verdict: VerifyVerdict,
  label: string,
  reason: string,
): VerifyResult {
  return { verdict, label, vacuity: verdict === 'not-reproduced', reason };
}

/** Types too common to confirm anything on their own. */
const GENERIC_TYPES = new Set(['Error', 'Exception', 'BaseException']);

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The error line a signature must appear on: the type (any namespace prefix,
 * an optional `Uncaught ` and Node ` [ERR_CODE]`), then `: message`, or for a
 * type-only signature `:` or end of line. A bare substring anywhere in the
 * output is not enough -- a code frame, console output or a diff can carry
 * the text while the run actually failed on something else.
 */
function errorLinePattern(type: string, text: string | null): RegExp {
  const short = type.split('.').pop()!;
  const head = `(?:^|[\\s>|-])(?:Uncaught\\s+)?(?:[\\w$]+\\.)*${escapeRe(short)}(?:\\s*\\[[A-Z0-9_]+\\])?`;
  const tail = text === null ? '(?::|\\s*$)' : `:\\s*${escapeRe(text)}`;
  return new RegExp(head + tail, 'm');
}

/** The pattern a signature confirms against, or why it cannot confirm. */
function signaturePattern(signature: Signature): RegExp | string {
  if (signature.kind === 'type-only') {
    const type = signature.type ?? signature.text;
    if (GENERIC_TYPES.has(type.split('.').pop()!)) {
      return `the type-only signature ${type} is too generic to confirm a reproduction; pass --expect with the error message`;
    }
    return errorLinePattern(type, null);
  }
  if (signature.type === undefined) return new RegExp(escapeRe(signature.text));
  return errorLinePattern(signature.type, signature.text);
}

/** Undo the string escapes a test would use to quote the error text. */
const unescape = (source: string) => source.replace(/\\(['"`\\])/g, '$1');

/**
 * A failing assertion prints its own source, so a test that quotes the
 * incident's error text "matches" whatever actually made it fail.
 */
function quotedBySource(
  signature: Signature,
  pattern: RegExp,
  testSource: string,
): boolean {
  const source = unescape(testSource);
  if (signature.kind === 'type-only') return pattern.test(source);
  return source.includes(signature.text);
}

function signatureVerdict(
  output: string,
  signature: Signature,
  testSource: string,
): VerifyResult {
  const pattern = signaturePattern(signature);
  if (typeof pattern === 'string') {
    return result('unverified', COULD_NOT_REPRODUCE, pattern);
  }
  if (quotedBySource(signature, pattern, testSource)) {
    return result(
      'failed-other-reason',
      'unverified',
      "the signature text appears in the test's own source, so finding it in the output does not show the defect fired; assert the correct behaviour instead of quoting the error",
    );
  }
  if (!pattern.test(output)) {
    return result(
      'failed-other-reason',
      'unverified',
      'the test failed, but no error line in its output carries the incident signature',
    );
  }
  return result(
    'reproduced',
    'reproduced',
    `an error line in the failure output carries the ${signature.kind} signature`,
  );
}

function verdictFor(
  exec: ExecuteResult,
  output: string,
  signature: Signature | null,
  testSource: string,
): VerifyResult {
  if (exec[0] === 0) {
    return result(
      'not-reproduced',
      'not-reproduced',
      'the test passed against the code it was written to catch',
    );
  }
  if (signature === null) {
    return result(
      'failed-other-reason',
      'unverified',
      'the test failed, but there is no signature to confirm against',
    );
  }
  return signatureVerdict(output, signature, testSource);
}

/**
 * Classify one run of a generated test against the incident's signature.
 * `testSource` is the test file's text; a signature it quotes cannot confirm.
 */
export function classifyRun(
  exec: ExecuteResult,
  signature: Signature | null,
  framework: string,
  testSource = '',
): VerifyResult {
  const output = `${exec[1]}\n${exec[2]}`.replace(ANSI, '');
  const tail = output.trimEnd().split('\n').slice(-TAIL_LINES);
  const notRun = couldNotRun(exec, framework);
  const verdict =
    notRun !== null
      ? result('unverified', COULD_NOT_REPRODUCE, notRun)
      : verdictFor(exec, output, signature, testSource);
  return { ...verdict, tail };
}

/** Framework from the test file extension (D9); null when unknown. */
export function inferFramework(path: string): string | null {
  if (path.endsWith('.py')) return 'pytest';
  if (/\.(spec|e2e)\.[cm]?[jt]sx?$/.test(path)) return 'playwright';
  if (/\.[cm]?[jt]sx?$/.test(path)) return 'vitest';
  return null;
}

/**
 * The realpath of `testPath` when it is a file under `<root>/tests/generated/`
 * (D6), else null. `verify` spawns a runner, so an unconfined path would be
 * arbitrary execution: both sides are realpath'd so neither `..` nor a symlink
 * planted inside `tests/generated/` can point the runner elsewhere. Same
 * argument as the MCP `run_tests` guard (`ts/src/mcp-server.ts`), restated
 * here because the entry layer is not importable from the engine.
 */
export function containedInGenerated(
  root: string,
  testPath: string,
): string | null {
  try {
    const base = realpathSync(join(root, 'tests', 'generated'));
    const real = realpathSync(resolve(root, testPath));
    if (!real.startsWith(base + sep)) return null;
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}
