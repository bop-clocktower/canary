/**
 * The rewind scratch workspace (#461 PR 2): which directory the runner starts
 * from, installing the old commit's dependencies, the files that ran before
 * the failed one, and the argument-array spawn. Install goes through an
 * injected `ExecFn`, so no package manager ever runs here; `spawnExec` is
 * exercised with the cheapest real process available (`node -e`).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  install,
  packageDir,
  predecessors,
  spawnExec,
  type ExecFn,
} from '../src/analysis/rewind/workspace.js';
import type { RunRecord, TestResultRecord } from '../src/history/record.js';
import { mkTmp, rmTmp } from './canary-cli-testkit.js';

let dir: string;

/** A private temp dir per test, for the describes that touch the disk. */
function useTmpDir(): void {
  beforeEach(() => {
    dir = mkTmp();
  });
  afterEach(() => {
    rmTmp(dir);
  });
}

function touch(...parts: string[]): void {
  const path = join(dir, ...parts);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{}', 'utf-8');
}

describe('packageDir', () => {
  useTmpDir();

  it('returns the nearest ancestor holding a package.json', () => {
    touch('packages', 'a', 'package.json');
    const file = 'packages/a/test/deep/x.test.ts';
    expect(packageDir(dir, file)).toBe(join(dir, 'packages', 'a'));
  });

  it('prefers the closer package.json over one further up', () => {
    touch('packages', 'package.json');
    touch('packages', 'a', 'package.json');
    expect(packageDir(dir, 'packages/a/x.test.ts')).toBe(
      join(dir, 'packages', 'a'),
    );
  });

  it('falls back to the tree root when no package.json sits below it', () => {
    expect(packageDir(dir, 'test/x.test.ts')).toBe(dir);
  });
});

interface ExecCall {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/** A fake package manager: records each call and exits with `code`. */
function fakeExec(code: number): { exec: ExecFn; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: ExecFn = async (command, args, opts) => {
    calls.push({ command, args, ...opts });
    return { code, output: '' };
  };
  return { exec, calls };
}

describe('install', () => {
  useTmpDir();

  it.each([
    ['package-lock.json', 'npm', ['ci']],
    ['pnpm-lock.yaml', 'pnpm', ['install', '--frozen-lockfile']],
    ['yarn.lock', 'yarn', ['install', '--frozen-lockfile']],
  ])('installs from %s with %s', async (lock, command, args) => {
    touch(lock);
    const fake = fakeExec(0);
    expect(await install(dir, fake)).toBeNull();
    expect(fake.calls).toEqual([{ command, args, cwd: dir, env: {} }]);
  });

  it('picks npm over yarn when both lockfiles are present', async () => {
    touch('yarn.lock');
    touch('package-lock.json');
    const fake = fakeExec(0);
    await install(dir, fake);
    expect(fake.calls.map((c) => c.command)).toEqual(['npm']);
  });

  it('skips the install when node_modules already exists', async () => {
    touch('package-lock.json');
    mkdirSync(join(dir, 'node_modules'));
    const fake = fakeExec(0);
    expect(await install(dir, fake)).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });

  it('does nothing, and reports no failure, without a lockfile', async () => {
    const fake = fakeExec(0);
    expect(await install(dir, fake)).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });

  it('names the command and exit code when the install fails', async () => {
    touch('pnpm-lock.yaml');
    expect(await install(dir, fakeExec(7))).toBe(
      'pnpm install --frozen-lockfile exited 7',
    );
  });
});

function result(
  file: string | undefined,
  start: number | undefined,
): TestResultRecord {
  // Absent, not undefined-valued: the record omits fields it did not capture.
  return {
    test_name: `t-${String(file)}-${String(start)}`,
    status: 'passed',
    ...(file === undefined ? {} : { test_file: file }),
    ...(start === undefined ? {} : { start_index: start }),
  };
}

function runOf(tests: TestResultRecord[] | undefined): RunRecord {
  const run: RunRecord = { run_id: 'r', suite: 's', schema_version: 3 };
  return tests === undefined ? run : { ...run, tests };
}

describe('predecessors', () => {
  const failed = result('test/z.test.ts', 5);

  it('lists files that started earlier, ordered by start index', () => {
    const run = runOf([
      result('test/c.test.ts', 3),
      result('test/a.test.ts', 0),
      result('test/b.test.ts', 1),
      failed,
    ]);
    expect(predecessors(run, failed)).toEqual([
      'test/a.test.ts',
      'test/b.test.ts',
      'test/c.test.ts',
    ]);
  });

  it('omits files that started at or after the failed one', () => {
    const run = runOf([
      result('test/same.test.ts', 5),
      result('test/later.test.ts', 9),
      failed,
    ]);
    expect(predecessors(run, failed)).toEqual([]);
  });

  it.each([
    ['an absolute path', '/abs/x.test.ts', 1],
    ['a path climbing out with ..', '../out/x.test.ts', 1],
    ['a Windows-style .. segment', 'test\\..\\..\\x.test.ts', 1],
    ['no recorded file', undefined, 1],
    ['no recorded start index', 'test/x.test.ts', undefined],
  ])('drops a test with %s', (_label, file, start) => {
    const run = runOf([result(file, start), failed]);
    expect(predecessors(run, failed)).toEqual([]);
  });

  it('returns nothing when the failed test has no start index', () => {
    const run = runOf([result('test/a.test.ts', 0)]);
    expect(predecessors(run, result('test/z.test.ts', undefined))).toEqual([]);
  });

  it('returns nothing when the run recorded no tests', () => {
    expect(predecessors(runOf(undefined), failed)).toEqual([]);
  });

  it('lists a file once even when several of its tests started earlier', () => {
    const run = runOf([
      result('test/a.test.ts', 1),
      result('test/a.test.ts', 1),
      failed,
    ]);
    expect(predecessors(run, failed)).toEqual(['test/a.test.ts']);
  });
});

describe('spawnExec', () => {
  useTmpDir();

  const script =
    "process.stdout.write('out:' + process.env.REWIND_PROBE);" +
    "process.stderr.write('|err');" +
    'process.exit(4);';

  it('captures stdout and stderr and passes the exit code and env', async () => {
    const res = await spawnExec(process.execPath, ['-e', script], {
      cwd: dir,
      env: { REWIND_PROBE: 'set' },
    });
    expect(res).toEqual({ code: 4, output: 'out:set|err' });
  });

  it('reports a command that cannot be spawned as exit 127', async () => {
    const res = await spawnExec('canary-rewind-no-such-binary', [], {
      cwd: dir,
      env: {},
    });
    expect(res.code).toBe(127);
    expect(res.output).toMatch(/ENOENT/);
  });
});
