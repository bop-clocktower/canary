// The pytest precondition for this suite (#1239).
//
// Three canary-savant integration tests spawn a REAL `python3 -m pytest`. On a
// machine whose python3 has no pytest they used to report three assertion
// failures (`expected undefined to be 'passed'`) that read exactly like broken
// code. A local red for an environmental reason trains people to ignore red.
//
// The fix has two halves, and both are pinned here:
//   - locally, a missing pytest ABSTAINS LOUDLY: one named warning and a real
//     vitest skip, so the summary reads "3 skipped", never "3 passed";
//   - under CI (or CANARY_REQUIRE_PYTEST=1) a missing pytest FAILS the run, so
//     an abstention can never turn the required "Skills (JS)" check green.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import config from '../vitest.config.js';
import {
  PYTEST_INTEGRATION_TESTS,
  checkPytestPrecondition,
  probePytest,
  pytestRequired,
} from './pytest-precondition.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILLS = path.resolve(HERE, '..');

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

/** A dir holding a `python3` that runs but has no pytest module. */
function stubPythonDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pytest-precond-'));
  tmps.push(d);
  const stub = path.join(d, 'python3');
  fs.writeFileSync(
    stub,
    '#!/bin/sh\necho "python3: No module named pytest" >&2\nexit 1\n',
  );
  fs.chmodSync(stub, 0o755);
  return d;
}

/** The parent env minus CI and the outer vitest worker's own variables. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'CI' || k === 'CANARY_REQUIRE_PYTEST') continue;
    if (k.startsWith('VITEST') || k === 'NODE_V8_COVERAGE') continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

const missing = () => ({ ok: false, reason: 'No module named pytest' });

describe('pytestRequired', () => {
  it.each([
    [{}, false],
    [{ CI: '' }, false],
    [{ CI: 'false' }, false],
    [{ CI: '0' }, false],
    [{ CI: 'true' }, true],
    [{ CI: '1' }, true],
    [{ CANARY_REQUIRE_PYTEST: '1' }, true],
  ])('%o -> %s', (env, expected) => {
    expect(pytestRequired(env)).toBe(expected);
  });
});

describe('checkPytestPrecondition', () => {
  it('runs the integration tests when pytest is importable', () => {
    const warnings: string[] = [];
    const ok = checkPytestPrecondition({
      env: { CI: 'true' },
      probe: () => ({ ok: true, reason: 'pytest 9.1.1' }),
      warn: (m) => warnings.push(m),
    });
    expect(ok).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('abstains LOUDLY locally: a named, counted warning, never silence', () => {
    const warnings: string[] = [];
    const ok = checkPytestPrecondition({
      env: {},
      probe: missing,
      warn: (m) => warnings.push(m),
    });
    expect(ok).toBe(false);
    expect(warnings).toHaveLength(1);
    const msg = warnings[0] as string;
    expect(msg).toContain(
      `pytest not installed — skipped ${PYTEST_INTEGRATION_TESTS.length} integration tests`,
    );
    for (const t of PYTEST_INTEGRATION_TESTS) expect(msg).toContain(t.title);
    expect(msg).toContain('requirements-dev.txt');
  });

  it.each([{ CI: 'true' }, { CANARY_REQUIRE_PYTEST: '1' }])(
    'FAILS instead of abstaining under %o',
    (env) => {
      expect(() =>
        checkPytestPrecondition({ env, probe: missing, warn: () => {} }),
      ).toThrow(/pytest not installed.*integration tests/);
    },
  );
});

describe.skipIf(process.platform === 'win32')('probePytest', () => {
  // POSIX-only: the stub is a shell script. The Skills (JS) job is ubuntu.
  it('reports a python3 without pytest as unavailable', () => {
    const dir = stubPythonDir();
    const r = probePytest({
      env: {
        ...process.env,
        PATH: `${dir}${path.delimiter}${process.env['PATH'] ?? ''}`,
      },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/exited 1/);
  });

  it('reports a missing python3 as unavailable', () => {
    const r = probePytest({ python: 'python3-does-not-exist-1239' });
    expect(r.ok).toBe(false);
  });
});

describe('the registry matches the gated describes', () => {
  it('is wired as a vitest globalSetup', () => {
    expect(config.test?.globalSetup).toContain('test/pytest-precondition.ts');
  });

  it('every listed integration describe is gated, and none are unlisted', () => {
    const gated: string[] = [];
    for (const f of fs.readdirSync(HERE)) {
      if (!f.endsWith('.test.ts')) continue;
      const src = fs.readFileSync(path.join(HERE, f), 'utf-8');
      for (const m of src.matchAll(
        /describe\.skipIf\(NO_PYTEST\)\(\s*'([^']+)'/g,
      ))
        gated.push(`${f} > ${m[1] as string}`);
    }
    const listed = PYTEST_INTEGRATION_TESTS.map(
      (t) => `${t.file} > ${t.title}`,
    );
    // A non-empty denominator first: an empty pair would compare equal.
    expect(listed.length).toBeGreaterThan(0);
    expect(gated.sort()).toEqual(listed.sort());
  });
});

// The reproducing test for #1239: run the three real files under a python3
// that lacks pytest. Before the fix this exited 1 with three code-shaped
// assertion failures.
describe.skipIf(process.platform === 'win32')(
  'savant integration files under a python3 without pytest (#1239)',
  () => {
    const files = [
      ...new Set(PYTEST_INTEGRATION_TESTS.map((t) => `test/${t.file}`)),
    ];

    function runNested(extra: Record<string, string>) {
      const dir = stubPythonDir();
      return spawnSync(
        process.execPath,
        [
          path.join(SKILLS, 'node_modules', 'vitest', 'vitest.mjs'),
          'run',
          ...files,
          '--coverage.enabled=false',
        ],
        {
          cwd: SKILLS,
          encoding: 'utf-8',
          timeout: 120_000,
          env: cleanEnv({
            PATH: `${dir}${path.delimiter}${process.env['PATH'] ?? ''}`,
            ...extra,
          }),
        },
      );
    }

    it('abstains loudly locally: exit 0, a named warning, 3 SKIPPED not passed', () => {
      const r = runNested({});
      const out = `${r.stdout}\n${r.stderr}`;
      expect(r.status, out).toBe(0);
      expect(out).toContain(
        `pytest not installed — skipped ${PYTEST_INTEGRATION_TESTS.length} integration tests`,
      );
      expect(out).toMatch(
        new RegExp(`${PYTEST_INTEGRATION_TESTS.length} skipped`),
      );
      expect(out).not.toMatch(/\d+ failed/);
    });

    it('FAILS under CI=true, so the required check cannot go falsely green', () => {
      const r = runNested({ CI: 'true' });
      const out = `${r.stdout}\n${r.stderr}`;
      expect(r.status, out).not.toBe(0);
      expect(out).toContain('pytest not installed');
    });
  },
);
