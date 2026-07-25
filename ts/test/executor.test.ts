/**
 * Faithful TypeScript port of `tests/unit/test_executor.py`.
 *
 * The CanaryTestExecutor runs a test file via the framework's CLI command.
 * Python patches `subprocess.run`; here `node:child_process` is mocked and
 * `spawnSync` stubbed. The captured command is reconstructed as
 * `[program, ...args]` to mirror the single Python `cmd` list.
 */

import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CanaryTestExecutor, shlexSplit } from '../src/core/executor.js';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

// The executor consults isCi() via process.env; clear CI vars so flag-append
// behavior is deterministic across local vs. CI test runs (Python left env
// untouched, but its assertions are CI-agnostic anyway).
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

const executor = new CanaryTestExecutor();

function mockSpawn(overrides: Record<string, unknown>): void {
  vi.mocked(spawnSync).mockReturnValue({
    status: 0,
    stdout: '',
    stderr: '',
    pid: 0,
    output: [],
    signal: null,
    ...overrides,
  } as ReturnType<typeof spawnSync>);
}

/** The full command list passed to spawnSync: `[program, ...args]`. */
function lastArgv(): string[] {
  const call = vi.mocked(spawnSync).mock.calls[0]!;
  return [call[0] as string, ...((call[1] as string[]) ?? [])];
}

beforeEach(() => {
  for (const v of CI_VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
  vi.mocked(spawnSync).mockReset();
});

afterEach(() => {
  for (const v of CI_VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

describe('CanaryTestExecutor', () => {
  it('execute success', () => {
    mockSpawn({ status: 0, stdout: 'Test Passed', stderr: '' });
    const [exitCode, stdout] = executor.execute('test.spec.ts', 'playwright');
    expect(exitCode).toBe(0);
    expect(stdout).toBe('Test Passed');
    expect(lastArgv()).toContain('playwright');
  });

  it('execute failure', () => {
    mockSpawn({ status: 1, stdout: '', stderr: 'Assertion Error' });
    const [exitCode, , stderr] = executor.execute('test.py', 'pytest');
    expect(exitCode).toBe(1);
    expect(stderr).toBe('Assertion Error');
  });

  it('invalid framework raises', () => {
    expect(() =>
      executor.execute('test.js', 'nonexistent-framework'),
    ).toThrow();
  });

  it('execute path with spaces stays a single argv element', () => {
    mockSpawn({ status: 0, stdout: '', stderr: '' });
    const filePath = '/tmp/canary test/my test.spec.ts';
    executor.execute(filePath, 'playwright');
    const argv = lastArgv();
    expect(argv).toContain(filePath);
    expect(argv.filter((a) => a.includes('my test.spec.ts')).length).toBe(1);
  });

  // Extra (not in the Python oracle): cover the timeout and generic-error
  // branches that Python exercised only implicitly via subprocess exceptions.
  it('maps spawnSync ETIMEDOUT to exit code 124 with a timeout message', () => {
    mockSpawn({
      status: null,
      stdout: 'partial',
      error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
    });
    const [exitCode, stdout, stderr] = executor.execute('test.py', 'pytest', 5);
    expect(exitCode).toBe(124);
    expect(stdout).toBe('partial');
    expect(stderr).toBe('Execution timed out after 5 seconds.');
  });

  it('maps a non-timeout spawn error to exit code 1 with its message', () => {
    mockSpawn({
      status: null,
      stdout: '',
      error: Object.assign(new Error('spawn npx ENOENT'), { code: 'ENOENT' }),
    });
    const [exitCode, stdout, stderr] = executor.execute(
      'test.spec.ts',
      'playwright',
    );
    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toBe('spawn npx ENOENT');
  });

  // Regression (adversarial review): Node's spawnSync defaults maxBuffer to
  // 1 MiB and kills the child on overflow; Python's subprocess.run has no cap.
  // A >1 MiB passing run must NOT be flipped to a failure. We assert the
  // executor requests an uncapped buffer (maxBuffer: Infinity), which is what
  // makes large-output runs behave like the Python oracle.
  it('runs the child with an uncapped output buffer (maxBuffer)', () => {
    mockSpawn({ status: 0, stdout: 'x'.repeat(10), stderr: '' });
    executor.execute('test.spec.ts', 'playwright');
    const opts = vi.mocked(spawnSync).mock.calls[0]![2] as {
      maxBuffer?: number;
    };
    expect(opts.maxBuffer).toBe(Infinity);
  });

  // Regression (adversarial review): a signal death (status=null, signal set,
  // no spawn error) must report the negative signal number like Python's
  // subprocess return code, not a flat 1.
  it('reports a signal death as the negative signal number', () => {
    mockSpawn({ status: null, signal: 'SIGKILL', stdout: 'out', stderr: '' });
    const [exitCode, stdout] = executor.execute('test.py', 'pytest');
    expect(exitCode).toBe(-9); // SIGKILL
    expect(stdout).toBe('out');
  });

  it('throws a clear error when no execution command is defined', () => {
    // A framework with a null/empty execution_command hits the second guard.
    const stub = {
      findByName: () => ({ name: 'noexec', execution_command: null }),
    } as unknown as ConstructorParameters<typeof CanaryTestExecutor>[0];
    const exec = new CanaryTestExecutor(stub);
    expect(() => exec.execute('t.ts', 'noexec')).toThrow(
      /No execution command defined/,
    );
  });
});

// Direct coverage of the POSIX shlex.split port (quotes/escapes are never hit
// by the simple framework templates but must tokenize correctly).
describe('shlexSplit', () => {
  it('splits on runs of whitespace', () => {
    expect(shlexSplit('a  b\tc\nd')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps single-quoted spans literal', () => {
    expect(shlexSplit("run 'a b' c")).toEqual(['run', 'a b', 'c']);
  });

  it('keeps double-quoted spans literal', () => {
    expect(shlexSplit('run "a b" c')).toEqual(['run', 'a b', 'c']);
  });

  it('honors backslash escapes outside quotes', () => {
    expect(shlexSplit('a\\ b')).toEqual(['a b']);
  });

  it('honors escaped quote and backslash inside double quotes', () => {
    expect(shlexSplit('"x\\"y"')).toEqual(['x"y']);
    expect(shlexSplit('"a\\\\b"')).toEqual(['a\\b']);
  });

  // Regression (adversarial review): Python shlex.split raises
  // `ValueError: No escaped character` on a trailing backslash, and that call
  // sits outside execute()'s try, so it propagates. Match the raise.
  it('raises on a trailing backslash (matches shlex.split)', () => {
    expect(() => shlexSplit('a\\')).toThrow(/No escaped character/);
  });

  // Regression (adversarial review): shlex.whitespace is only ' \t\r\n'.
  // Form-feed (\f) and vertical-tab (\v) are NOT separators — they stay inside
  // the token, unlike an earlier draft that split on them.
  it('treats form-feed and vertical-tab as ordinary token characters', () => {
    expect(shlexSplit('a\fb')).toEqual(['a\fb']);
    expect(shlexSplit('a\vb')).toEqual(['a\vb']);
  });

  it('returns an empty list for whitespace-only input', () => {
    expect(shlexSplit('   ')).toEqual([]);
    expect(shlexSplit('')).toEqual([]);
  });
});
