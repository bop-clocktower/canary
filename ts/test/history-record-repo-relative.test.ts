/**
 * `canary history record` inside a real git repository (#1021).
 *
 * Proposal 460 success criterion 1, end to end: a report produced in a
 * SUBDIRECTORY of the repo stores `test_file` values equal to what
 * `git ls-files` prints, whichever reader produced them; a report that cannot
 * be joined says how much of it could not be, rather than reporting 0. And a
 * run recorded in a repo whose HEAD resolves never stores `commit_sha: local`.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

const STORE = join('test-results', 'reports', 'history-v2.jsonl');

/** Env that leaves no CI commit to fall back on. */
const LOCAL_ENV = {
  GITHUB_REPOSITORY: 'acme/widgets',
  GITHUB_REF_NAME: undefined,
  GITHUB_SHA: undefined,
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'user.name=t',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf-8' },
  ).trim();
}

function write(path: string, body: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf-8');
  return path;
}

/** A repo with two committed test files under `ts/`, one commit deep. */
function makeRepo(): string {
  const repo = mkTmp();
  git(repo, 'init', '-q');
  write(join(repo, 'ts', 'test', 'a.test.ts'), '');
  write(join(repo, 'ts', 'e2e', 'checkout.spec.ts'), '');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

function storedRows(cwd: string): {
  commit_sha: string;
  tests: { test_file: string }[];
} {
  const line = readFileSync(join(cwd, STORE), 'utf-8').trim();
  return JSON.parse(line) as {
    commit_sha: string;
    tests: { test_file: string }[];
  };
}

describe('history record: repo-relative test_file (#1021)', () => {
  it('stores vitest absolute paths as the paths git ls-files prints', async () => {
    const repo = makeRepo();
    try {
      const sub = join(repo, 'ts');
      const report = write(
        join(sub, 'vitest.json'),
        JSON.stringify({
          testResults: [
            {
              name: join(sub, 'test', 'a.test.ts'),
              assertionResults: [{ fullName: 'a', status: 'passed' }],
            },
          ],
        }),
      );
      const res = await invokeCanary(
        ['history', 'record', report, '--suite', 'ts'],
        { cwd: sub, env: LOCAL_ENV },
      );
      expect(res.code).toBe(0);
      const files = storedRows(sub).tests.map((t) => t.test_file);
      expect(files).toEqual([git(repo, 'ls-files', '--', 'ts/test')]);
      expect(res.stdout).toContain('unjoinableTestFiles: 0 of 1');
    } finally {
      rmTmp(repo);
    }
  });

  it('prefixes Playwright paths with the testDir from the report config', async () => {
    const repo = makeRepo();
    try {
      const report = write(
        join(repo, 'pw.json'),
        JSON.stringify({
          config: { rootDir: join(repo, 'ts', 'e2e') },
          suites: [
            {
              title: 'checkout.spec.ts',
              file: 'checkout.spec.ts',
              specs: [
                {
                  title: 'adds',
                  tests: [{ status: 'expected', results: [] }],
                },
              ],
            },
          ],
        }),
      );
      const res = await invokeCanary(
        ['history', 'record', report, '--suite', 'e2e', '--json'],
        { cwd: repo, env: LOCAL_ENV },
      );
      expect(res.code).toBe(0);
      expect(storedRows(repo).tests[0]!.test_file).toBe(
        git(repo, 'ls-files', '--', 'ts/e2e'),
      );
      expect(JSON.parse(res.stdout)).toMatchObject({ unjoinableTestFiles: 0 });
    } finally {
      rmTmp(repo);
    }
  });

  it('counts every row of a JUnit report with no file attributes as unjoinable', async () => {
    const repo = makeRepo();
    try {
      const report = write(
        join(repo, 'junit.xml'),
        '<testsuite name="s"><testcase classname="c" name="one"/>' +
          '<testcase classname="c" name="two"/></testsuite>',
      );
      const res = await invokeCanary(
        ['history', 'record', report, '--suite', 'py', '--json'],
        { cwd: repo, env: LOCAL_ENV },
      );
      expect(res.code).toBe(0);
      expect(JSON.parse(res.stdout)).toMatchObject({
        checked: 2,
        unjoinableTestFiles: 2,
      });
      // Kept, not dropped: both rows are still in the store.
      expect(storedRows(repo).tests).toHaveLength(2);
    } finally {
      rmTmp(repo);
    }
  });

  it('reports unjoinable rows in the human success line too', async () => {
    const repo = makeRepo();
    try {
      const report = write(
        join(repo, 'junit.xml'),
        '<testsuite name="s"><testcase classname="c" name="one" ' +
          'file="ts/test/a.test.ts"/><testcase classname="c" name="two" ' +
          'file="/somewhere/else.py"/></testsuite>',
      );
      const res = await invokeCanary(
        ['history', 'record', report, '--suite', 'py'],
        { cwd: repo, env: LOCAL_ENV },
      );
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('unjoinableTestFiles: 1 of 2');
      expect(storedRows(repo).tests.map((t) => t.test_file)).toEqual([
        'ts/test/a.test.ts',
        '/somewhere/else.py',
      ]);
    } finally {
      rmTmp(repo);
    }
  });
});

describe('history record: honest commit_sha (#1021)', () => {
  const vitestJson = JSON.stringify({
    testResults: [
      { name: 'x', assertionResults: [{ fullName: 'a', status: 'passed' }] },
    ],
  });

  it('records HEAD instead of local when no commit is given in a git repo', async () => {
    const repo = makeRepo();
    try {
      const report = write(join(repo, 'v.json'), vitestJson);
      const res = await invokeCanary(
        ['history', 'record', report, '--suite', 's'],
        { cwd: repo, env: LOCAL_ENV },
      );
      expect(res.code).toBe(0);
      expect(storedRows(repo).commit_sha).toBe(git(repo, 'rev-parse', 'HEAD'));
    } finally {
      rmTmp(repo);
    }
  });

  it('refuses an explicit --commit local while HEAD resolves', async () => {
    const repo = makeRepo();
    try {
      const report = write(join(repo, 'v.json'), vitestJson);
      const res = await invokeCanary(
        ['history', 'record', report, '--suite', 's', '--commit', 'local'],
        { cwd: repo, env: LOCAL_ENV },
      );
      expect(res.code).toBe(0);
      expect(storedRows(repo).commit_sha).toBe(git(repo, 'rev-parse', 'HEAD'));
      expect(res.stderr).toContain("refused commit_sha 'local'");
    } finally {
      rmTmp(repo);
    }
  });

  it('keeps local outside a git repo, where there is no HEAD to record', async () => {
    const tmp = mkTmp();
    try {
      const report = write(join(tmp, 'v.json'), vitestJson);
      const res = await invokeCanary(
        ['history', 'record', report, '--suite', 's'],
        { cwd: tmp, env: LOCAL_ENV },
      );
      expect(res.code).toBe(0);
      expect(storedRows(tmp).commit_sha).toBe('local');
    } finally {
      rmTmp(tmp);
    }
  });

  it('keeps local in a fresh repo with no commits, where HEAD does not resolve', async () => {
    const tmp = mkTmp();
    try {
      git(tmp, 'init', '-q');
      const report = write(join(tmp, 'v.json'), vitestJson);
      const res = await invokeCanary(
        ['history', 'record', report, '--suite', 's'],
        { cwd: tmp, env: LOCAL_ENV },
      );
      expect(res.code).toBe(0);
      expect(storedRows(tmp).commit_sha).toBe('local');
    } finally {
      rmTmp(tmp);
    }
  });
});
