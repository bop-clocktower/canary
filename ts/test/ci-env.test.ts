/**
 * Faithful TypeScript port of `tests/unit/test_ci_env.py`.
 *
 * Covers isCi() over each recognized CI variable and the integration case
 * (TestExecutorCIFlags): the executor appends a framework's CI flags when
 * isCi() is true.
 *
 * Python→TS: `patch.dict(os.environ, ..., clear=True)` becomes a save/clear of
 * the CI vars in beforeEach + restore in afterEach; `patch("...subprocess.run")`
 * becomes `vi.mock('node:child_process')` with a mocked `spawnSync`.
 */

import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isCi } from '../src/core/ci-env.js';
import { CanaryTestExecutor } from '../src/core/executor.js';

// Hoisted above all imports by vitest, so executor sees the mocked spawnSync.
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

const CI_VARS = [
  'CI',
  'GITHUB_ACTIONS',
  'CIRCLECI',
  'TRAVIS',
  'CI_SERVER',
  'BITBUCKET_BUILD_NUMBER',
  'JENKINS_URL',
  'TEAMCITY_VERSION',
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  // Emulate patch.dict(..., clear=True) for the CI indicator vars only.
  for (const v of CI_VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
});

afterEach(() => {
  for (const v of CI_VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

describe('isCi', () => {
  it('false when no CI vars set', () => {
    expect(isCi()).toBe(false);
  });

  it.each([
    ['CI', 'true'],
    ['GITHUB_ACTIONS', 'true'],
    ['CIRCLECI', 'true'],
    ['TRAVIS', 'true'],
    ['CI_SERVER', 'yes'],
    ['BITBUCKET_BUILD_NUMBER', '42'],
    ['JENKINS_URL', 'http://jenkins/'],
    ['TEAMCITY_VERSION', '2023.1'],
  ])('true when %s is set', (name, value) => {
    process.env[name] = value;
    expect(isCi()).toBe(true);
  });

  it('false when CI is empty string', () => {
    process.env.CI = '';
    expect(isCi()).toBe(false);
  });

  it('true when CI is "0" (non-empty is truthy — CI-present)', () => {
    process.env.CI = '0';
    expect(isCi()).toBe(true);
  });
});

describe('executor CI flags (integration)', () => {
  const executor = new CanaryTestExecutor();

  beforeEach(() => {
    vi.mocked(spawnSync).mockReset();
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '',
      stderr: '',
      pid: 0,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);
  });

  /** Run execute() with spawnSync mocked, return the full command list used. */
  function capturedCmd(frameworkName: string): string[] {
    executor.execute('/tmp/test_foo.py', frameworkName);
    const call = vi.mocked(spawnSync).mock.calls[0]!;
    // spawnSync(program, args) → reconstruct the Python `cmd` list.
    return [call[0] as string, ...((call[1] as string[]) ?? [])];
  }

  it('pytest CI flags appended in CI', () => {
    process.env.CI = 'true';
    const cmd = capturedCmd('pytest');
    expect(cmd).toContain('--tb=short');
    expect(cmd).toContain('no:cacheprovider');
  });

  it('playwright CI flag appended in CI', () => {
    process.env.CI = 'true';
    const cmd = capturedCmd('playwright');
    expect(cmd).toContain('--reporter=list');
  });

  it('vitest CI flag appended in CI', () => {
    process.env.CI = 'true';
    const cmd = capturedCmd('vitest');
    expect(cmd).toContain('--reporter=verbose');
  });

  it('no extra flags outside CI', () => {
    const cmd = capturedCmd('pytest');
    expect(cmd).not.toContain('--tb=short');
  });

  it('k6 has no CI flags — base command unchanged', () => {
    process.env.CI = 'true';
    const cmd = capturedCmd('k6');
    expect(cmd[0]).toContain('k6');
    const baseLen = 'k6 run /tmp/test_foo.py'.split(' ').length;
    expect(cmd.length).toBe(baseLen);
  });
});
