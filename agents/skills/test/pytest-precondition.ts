// pytest precondition for the agents/skills suite (#1239).
//
// Three canary-savant integration tests spawn a REAL `python3 -m pytest` (the
// Tier-2 JUnit parse, node-id collection, and polluter seams). On a machine
// whose python3 has no pytest they used to fail with assertion errors such as
// `expected undefined to be 'passed'`: an environment gap reported as broken
// code, which trains people to ignore red.
//
// This runs once as vitest `globalSetup`, probes the same `python3` the runner
// spawns, and hands the answer to the test files via `provide`/`inject`:
//
//   - pytest present: the tests run.
//   - pytest missing, locally: ONE loud, counted warning and a real vitest skip
//     (the summary reads "3 skipped"). A silent skip would be a zero
//     denominator reported as a pass.
//   - pytest missing under CI, or with CANARY_REQUIRE_PYTEST=1: the run FAILS.
//     CI installs pytest (requirements-dev.txt), so a missing one there is a
//     broken job, and an abstention must never turn the required "Skills (JS)"
//     check green. Same contract as ts/test/order-pytest-conftest.test.ts.

import { spawnSync } from 'node:child_process';

import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** True when `python3 -m pytest` works; the integration describes skip otherwise. */
    pytestAvailable: boolean;
  }
}

/**
 * Every describe gated on pytest. The registry test asserts this list equals
 * the `describe.skipIf(NO_PYTEST)(...)` blocks in test/, so the counted
 * warning cannot drift from what is actually skipped.
 */
export const PYTEST_INTEGRATION_TESTS = [
  {
    file: 'canary-savant.dynamic.test.ts',
    title: 'real pytest baseline (integration, no plugin needed)',
  },
  {
    file: 'canary-savant.phase4.test.ts',
    title: 'collectPytestNodeIds (integration)',
  },
  {
    file: 'canary-savant.polluter.test.ts',
    title: 'realPolluterSeams (integration)',
  },
] as const;

type Env = Record<string, string | undefined>;

export interface ProbeResult {
  ok: boolean;
  reason: string;
}

/** CI (any value but '', '0', 'false') or CANARY_REQUIRE_PYTEST=1 forbids abstaining. */
export function pytestRequired(env: Env): boolean {
  if (env['CANARY_REQUIRE_PYTEST'] === '1') return true;
  const ci = (env['CI'] ?? '').trim().toLowerCase();
  return ci !== '' && ci !== '0' && ci !== 'false';
}

/** Ask the interpreter the runner spawns whether it can import pytest. */
export function probePytest(
  options: { python?: string; env?: NodeJS.ProcessEnv } = {},
): ProbeResult {
  const python = options.python ?? 'python3';
  const r = spawnSync(python, ['-m', 'pytest', '--version'], {
    encoding: 'utf-8',
    env: options.env ?? process.env,
    timeout: 30_000,
  });
  if (r.error) return { ok: false, reason: `${python}: ${r.error.message}` };
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || '').trim().split('\n').pop() ?? '';
    return {
      ok: false,
      reason: `${python} -m pytest exited ${String(r.status)}: ${detail}`,
    };
  }
  return { ok: true, reason: (r.stdout || r.stderr || '').trim() };
}

export interface PytestPreconditionOptions {
  env?: Env;
  probe?: () => ProbeResult;
  warn?: (message: string) => void;
}

/**
 * @returns true when the pytest integration tests should run; false when they
 *   abstain (with a loud warning). Throws when abstaining is not allowed.
 */
export function checkPytestPrecondition(
  options: PytestPreconditionOptions = {},
): boolean {
  const env = options.env ?? process.env;
  const probe = options.probe ?? (() => probePytest());
  const warn = options.warn ?? ((m: string) => console.warn(m));

  const { ok, reason } = probe();
  if (ok) return true;

  const n = PYTEST_INTEGRATION_TESTS.length;
  const list = PYTEST_INTEGRATION_TESTS.map(
    (t) => `  - ${t.file} > ${t.title}`,
  ).join('\n');
  const fix =
    'Install it with `python3 -m pip install -r requirements-dev.txt` from ' +
    'the repo root (see AGENTS.md "First-time clone setup").';

  if (pytestRequired(env)) {
    throw new Error(
      `FAILED: pytest not installed — ${n} integration tests cannot run ` +
        `(${reason}). Abstaining is not allowed under CI or ` +
        `CANARY_REQUIRE_PYTEST=1 — a skipped gate is not a passing one.\n` +
        `${list}\n${fix}`,
    );
  }
  warn(
    `\nWARNING: pytest not installed — skipped ${n} integration tests ` +
      `(${reason}). These did NOT pass; they did not run:\n${list}\n` +
      `${fix} Under CI this is a failure.\n`,
  );
  return false;
}

/** vitest globalSetup entry: probes once, before any test file is collected. */
export default function setup(project: TestProject): void {
  project.provide('pytestAvailable', checkPytestPrecondition());
}
