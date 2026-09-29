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
}

const ANSI = /\x1b\[[0-9;]*m/g;
const COULD_NOT_REPRODUCE = 'unverified — could not reproduce';
/** Runner output that means nothing was collected. */
const NOT_COLLECTED = [
  /No test files found/i,
  /No test suite found/i,
  /No tests found/i,
];
const SPAWN_FAILED = /ENOENT|EACCES|spawn/;
/** pytest: 2 interrupted (incl. collection errors), 3 internal, 4 usage, 5 none collected. */
const PYTEST_NOT_RUN = new Set([2, 3, 4, 5]);

function couldNotRun(exec: ExecuteResult, framework: string): string | null {
  const [code, stdout, stderr] = exec;
  if (code === 124) return 'the run timed out';
  if (code === 127) return 'the runner command was not found';
  if (framework === 'pytest' && PYTEST_NOT_RUN.has(code)) {
    return `pytest exited ${code}: nothing was collected or run`;
  }
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

/** Classify one run of a generated test against the incident's signature. */
export function classifyRun(
  exec: ExecuteResult,
  signature: Signature | null,
  framework: string,
): VerifyResult {
  const notRun = couldNotRun(exec, framework);
  if (notRun !== null) return result('unverified', COULD_NOT_REPRODUCE, notRun);
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
  const output = `${exec[1]}\n${exec[2]}`.replace(ANSI, '');
  if (output.includes(signature.text)) {
    return result(
      'reproduced',
      'reproduced',
      `the failure output carries the ${signature.kind} signature`,
    );
  }
  return result(
    'failed-other-reason',
    'unverified',
    'the test failed, but its output does not carry the incident signature',
  );
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
