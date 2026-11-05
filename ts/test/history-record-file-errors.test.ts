/**
 * Failures outside any test must reach the history store under a stable name
 * (#1411).
 *
 * Every `errors` fixture below copies the shape of a real report from
 * Playwright 1.64.1's JSON reporter, with paths shortened. What those runs
 * showed, which the assertions pin:
 *
 *   - A spec that fails to load aborts the WHOLE run: `suites: []`, so `record`
 *     used to abstain and store nothing, though Playwright exited 1.
 *   - A throwing globalTeardown leaves the tests intact, so it used to store
 *     `failed: 0` for a run Playwright failed.
 *   - `No tests found` and `Testing stopped early` also arrive in `errors`, but
 *     neither is a failure of its own.
 *   - A failure inside a test (afterAll, a late throw, a worker fixture) never
 *     reaches `errors`, so test rows and error rows cannot overlap.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readReplayStatus } from '../src/analysis/rewind/runner.js';
import {
  buildRunFromReport,
  countReportResults,
} from '../src/history/run-recorder.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

const CTX = {
  suite: 'web',
  repo: 'acme/widgets',
  branch: 'main',
  commitSha: 'deadbeefcafe',
  nowMs: 1_754_000_000_000,
};

const SUFFIX = '(file failed outside any test)';
const RUN_ROW = '(run failed outside any test)';
const RED = '\u001b[31m';
const RESET = '\u001b[39m';

const loadError = (file: string, message = 'Error: boom at load') => ({
  message,
  stack: `${message}\n    at Object.<anonymous> (${file}:2:7)`,
  location: { file, column: 7, line: 2 },
  snippet: 'source excerpt',
});
const NO_TESTS = { message: 'Error: No tests found', stack: 'Error: ...' };
const STOPPED = {
  message: `${RED}Testing stopped early after 1 maximum allowed failures.${RESET}`,
};

const passingSuite = {
  title: 'good.spec.ts',
  file: 'good.spec.ts',
  specs: [
    {
      title: 'adds',
      file: 'good.spec.ts',
      tests: [
        {
          status: 'expected',
          results: [{ status: 'passed', duration: 5 }],
        },
      ],
    },
  ],
};

const build = (report: unknown) =>
  buildRunFromReport('playwright', report, CTX);

describe('Playwright top-level errors', () => {
  it('records each spec that failed to load as one failed row', () => {
    const report = {
      stats: { duration: 19.5 },
      suites: [],
      errors: [
        loadError('/repo/e2e/a.spec.ts'),
        loadError('/repo/e2e/b.spec.ts'),
      ],
    };
    // The count is what the CLI gates on: without it, this run abstains and
    // the reader is never reached.
    expect(countReportResults(report)).toBe(2);
    const { run, results } = build(report);
    expect(run).toMatchObject({ total: 2, failed: 2, passed: 0 });
    expect(results[0]).toMatchObject({
      test_name: `/repo/e2e/a.spec.ts ${SUFFIX}`,
      test_file: '/repo/e2e/a.spec.ts',
      status: 'failed',
      error_text: 'Error: boom at load',
    });
    expect(results[1]!.test_name).toBe(`/repo/e2e/b.spec.ts ${SUFFIX}`);
  });

  it('adds a failed row beside tests that passed when global teardown throws', () => {
    const report = {
      suites: [passingSuite],
      errors: [loadError('/repo/teardown.ts', 'Error: teardown boom')],
    };
    expect(build(report).run).toMatchObject({
      total: 2,
      passed: 1,
      failed: 1,
    });
  });

  it('names an error with no location after the run, with no file', () => {
    const message =
      'Error: Process from config.webServer was not able to start. Exit code: 3';
    const { results } = build({ suites: [], errors: [{ message, stack: '' }] });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      test_name: RUN_ROW,
      test_file: '',
      status: 'failed',
      error_text: message,
    });
  });

  it('keeps a thrown non-Error, which carries `value` and no `message`', () => {
    const { results } = build({
      suites: [],
      errors: [{ value: 'plain string' }],
    });
    expect(results[0]).toMatchObject({
      status: 'failed',
      error_text: 'plain string',
    });
  });

  it('truncates the error text like every other row', () => {
    const { results } = build({
      suites: [],
      errors: [{ message: 'x'.repeat(5000) }],
    });
    expect(results[0]!.error_text).toHaveLength(2000);
  });

  it('counts a global timeout, reported in red, as a failure', () => {
    const message = `${RED}Timed out waiting 0.5s for the test suite to run${RESET}`;
    const { run } = build({ suites: [passingSuite], errors: [{ message }] });
    expect(run.failed).toBe(1);
  });

  it('gives repeated errors distinct names, one row per error', () => {
    // A helper imported by two specs is reported twice at the same location.
    // The name is the join key, and flake counters add one per row, so a shared
    // name would count one history twice in a single run.
    const helper = '/repo/e2e/h.ts';
    const { run, results } = build({
      suites: [],
      errors: [
        loadError(helper),
        loadError(helper),
        { message: 'Error: one' },
        { message: 'Error: two' },
      ],
    });
    expect(run.failed).toBe(4);
    expect(results.map((r) => r.test_name)).toEqual([
      `${helper} ${SUFFIX}`,
      `${helper} ${SUFFIX} #2`,
      RUN_ROW,
      `${RUN_ROW} #2`,
    ]);
  });

  it('does not double count the max-failures notice against the test results', () => {
    const report = {
      suites: [
        {
          title: 'f.spec.ts',
          file: 'f.spec.ts',
          specs: [
            {
              title: 'breaks',
              tests: [
                {
                  status: 'unexpected',
                  results: [{ status: 'failed', duration: 1 }],
                },
              ],
            },
          ],
        },
      ],
      errors: [STOPPED],
    };
    expect(countReportResults(report)).toBe(1);
    expect(build(report).run).toMatchObject({ total: 1, failed: 1 });
  });

  it('leaves a run with no tests at all as an abstention', () => {
    expect(countReportResults({ suites: [], errors: [NO_TESTS] })).toBe(0);
    expect(countReportResults({ suites: [], errors: [] })).toBe(0);
    expect(countReportResults({ suites: [] })).toBe(0);
  });

  it('drops the No tests found that follows load errors', () => {
    const report = {
      suites: [],
      errors: [loadError('/repo/e2e/a.spec.ts'), NO_TESTS],
    };
    expect(countReportResults(report)).toBe(1);
    expect(build(report).run).toMatchObject({ total: 1, failed: 1 });
  });

  it('counts a located error even when its text resembles a notice', () => {
    const report = {
      suites: [],
      errors: [loadError('/repo/e2e/a.spec.ts', 'Error: No tests found')],
    };
    expect(countReportResults(report)).toBe(1);
  });

  it('records an unlocated error that only starts like the notice', () => {
    const report = {
      suites: [],
      errors: [{ message: 'Error: No tests found in manifest, DB is down' }],
    };
    expect(countReportResults(report)).toBe(1);
    expect(build(report).results[0]).toMatchObject({
      test_name: RUN_ROW,
      status: 'failed',
    });
  });

  it('records an unlocated error that only starts like the stop notice', () => {
    const message =
      'Testing stopped early after 3 maximum allowed failures of the DB pool';
    const report = { suites: [], errors: [{ message }] };
    expect(countReportResults(report)).toBe(1);
  });

  it.each([
    ['the bare form', 'Error: No tests found'],
    [
      'the form printed when a file argument was passed',
      'Error: No tests found.\nMake sure that arguments are regular expressions matching test files.\nYou may need to escape symbols like "$" or "*" and quote the arguments.',
    ],
  ])('still drops the real No tests found notice: %s', (_label, message) => {
    expect(countReportResults({ suites: [], errors: [{ message }] })).toBe(0);
  });

  it.each([
    ['a numeric message', { message: 42 }],
    ['a null message', { message: null }],
    [
      'a numeric message with a location',
      { message: 42, location: { file: 'a' } },
    ],
    ['a numeric location file', { message: 'boom', location: { file: 7 } }],
  ])('abstains on a malformed entry with %s, without throwing', (_l, entry) => {
    const report = { suites: [], errors: [entry] };
    expect(countReportResults(report)).toBe(0);
    expect(build({ ...report, suites: [passingSuite] }).run).toMatchObject({
      total: 1,
      failed: 0,
    });
  });

  it('ignores an errors field that is not a list of objects', () => {
    expect(countReportResults({ suites: [], errors: 'nope' })).toBe(0);
    expect(countReportResults({ suites: [], errors: [null, 'x'] })).toBe(0);
  });
});

describe('record: names of failures outside any test', () => {
  const STORE = join('test-results', 'reports', 'history-v2.jsonl');
  const ENV = {
    GITHUB_REPOSITORY: 'acme/widgets',
    GITHUB_REF_NAME: undefined,
    GITHUB_SHA: undefined,
  };

  function git(cwd: string, ...args: string[]): void {
    const identity = [
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'user.name=t',
    ];
    const signing = ['-c', 'commit.gpgsign=false'];
    execFileSync('git', [...identity, ...signing, ...args], { cwd });
  }

  function write(path: string, body: unknown): string {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(body), 'utf-8');
    return path;
  }

  /** A committed repo holding one test file at `ts/e2e/bad.spec.ts`. */
  function makeRepo(): string {
    const repo = mkTmp();
    git(repo, 'init', '-q');
    write(join(repo, 'ts', 'e2e', 'bad.spec.ts'), '');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    return repo;
  }

  interface StoredRun {
    failed: number;
    tests: { test_name: string; test_file: string }[];
  }

  const stored = (cwd: string): StoredRun =>
    JSON.parse(readFileSync(join(cwd, STORE), 'utf-8').trim()) as StoredRun;

  // A passing file beside the broken one: a vitest report where every file
  // fails to load still abstains, which this suite does not change.
  const vitestLoadFailure = (root: string) => ({
    testResults: [
      {
        name: join(root, 'ts', 'e2e', 'bad.spec.ts'),
        status: 'failed',
        message: 'Cannot find module',
        assertionResults: [],
      },
      {
        name: join(root, 'ts', 'e2e', 'good.spec.ts'),
        status: 'passed',
        assertionResults: [{ fullName: 'good works', status: 'passed' }],
      },
    ],
  });

  async function recordVitestIn(repo: string): Promise<StoredRun> {
    const report = write(join(repo, 'v.json'), vitestLoadFailure(repo));
    const res = await invokeCanary(
      ['history', 'record', report, '--suite', 's'],
      { cwd: repo, env: ENV },
    );
    expect(res.code).toBe(0);
    return stored(repo);
  }

  it('stores a Playwright load failure instead of abstaining', async () => {
    const repo = makeRepo();
    try {
      const report = write(join(repo, 'pw.json'), {
        config: { rootDir: join(repo, 'ts', 'e2e') },
        suites: [],
        errors: [loadError(join(repo, 'ts', 'e2e', 'bad.spec.ts')), NO_TESTS],
      });
      const res = await invokeCanary(
        ['history', 'record', report, '--suite', 'e2e'],
        { cwd: repo, env: ENV },
      );
      expect(res.code).toBe(0);
      const run = stored(repo);
      expect(run.failed).toBe(1);
      expect(run.tests).toEqual([
        expect.objectContaining({
          test_name: `ts/e2e/bad.spec.ts ${SUFFIX}`,
          test_file: 'ts/e2e/bad.spec.ts',
        }),
      ]);
    } finally {
      rmTmp(repo);
    }
  });

  it('still abstains with exit 3 when Playwright found no tests', async () => {
    const repo = makeRepo();
    try {
      const report = write(join(repo, 'pw.json'), {
        suites: [],
        errors: [NO_TESTS],
      });
      const res = await invokeCanary(
        ['history', 'record', report, '--suite', 'e2e'],
        { cwd: repo, env: ENV },
      );
      expect(res.code).toBe(3);
      expect(() => stored(repo)).toThrow();
    } finally {
      rmTmp(repo);
    }
  });

  it('abstains on a malformed errors entry instead of crashing', async () => {
    const repo = makeRepo();
    try {
      const report = write(join(repo, 'p.json'), {
        suites: [],
        errors: [{ message: 42 }],
      });
      const { code } = await invokeCanary(
        ['history', 'record', report, '--suite', 's'],
        { cwd: repo, env: ENV },
      );
      expect(code).toBe(3);
    } finally {
      rmTmp(repo);
    }
  });

  it('gives one file the same test_name from two checkouts', async () => {
    const first = makeRepo();
    const second = makeRepo();
    try {
      const a = await recordVitestIn(first);
      const b = await recordVitestIn(second);
      expect(a.tests[0]!.test_name).toBe(`ts/e2e/bad.spec.ts ${SUFFIX}`);
      expect(b.tests[0]!.test_name).toBe(a.tests[0]!.test_name);
    } finally {
      rmTmp(first);
      rmTmp(second);
    }
  });

  it('keeps the numbered name of a repeated error repo-relative', async () => {
    const repo = makeRepo();
    try {
      const file = join(repo, 'ts', 'e2e', 'bad.spec.ts');
      const report = write(join(repo, 'pw.json'), {
        suites: [],
        errors: [loadError(file), loadError(file)],
      });
      const res = await invokeCanary(
        ['history', 'record', report, '--suite', 'e2e'],
        { cwd: repo, env: ENV },
      );
      expect(res.code).toBe(0);
      expect(stored(repo).tests.map((t) => t.test_name)).toEqual([
        `ts/e2e/bad.spec.ts ${SUFFIX}`,
        `ts/e2e/bad.spec.ts ${SUFFIX} #2`,
      ]);
    } finally {
      rmTmp(repo);
    }
  });

  it('keeps the name as written, and counts it, outside any repository', async () => {
    const tmp = mkTmp();
    try {
      const report = write(join(tmp, 'v.json'), vitestLoadFailure(tmp));
      const res = await invokeCanary(
        ['history', 'record', report, '--suite', 's'],
        { cwd: tmp, env: ENV },
      );
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('unjoinableTestFiles: 2 of 2');
      expect(stored(tmp).tests[0]!.test_name).toBe(
        `${join(tmp, 'ts', 'e2e', 'bad.spec.ts')} ${SUFFIX}`,
      );
    } finally {
      rmTmp(tmp);
    }
  });

  it('leaves a real test name alone when its file is made repo-relative', async () => {
    const repo = makeRepo();
    try {
      const report = write(join(repo, 'v.json'), {
        testResults: [
          {
            name: join(repo, 'ts', 'e2e', 'bad.spec.ts'),
            status: 'passed',
            assertionResults: [{ fullName: 'bad works', status: 'passed' }],
          },
        ],
      });
      await invokeCanary(['history', 'record', report, '--suite', 's'], {
        cwd: repo,
        env: ENV,
      });
      expect(stored(repo).tests[0]).toMatchObject({
        test_name: 'bad works',
        test_file: 'ts/e2e/bad.spec.ts',
      });
    } finally {
      rmTmp(repo);
    }
  });
});

describe('rewind: replaying a failure outside any test', () => {
  // The stored name is repo-relative; the replay's reader writes the path as
  // the runner reported it. Without this join a reproduced load failure reads
  // as "the report does not hold that test".
  const stored = {
    testName: `ts/e2e/bad.spec.ts ${SUFFIX}`,
    file: 'ts/e2e/bad.spec.ts',
    root: '/ci/checkout',
  };
  const vitest = JSON.stringify({
    testResults: [
      {
        name: '/ci/checkout/ts/e2e/bad.spec.ts',
        status: 'failed',
        message: 'Cannot find module',
        assertionResults: [],
      },
    ],
  });

  it('finds the vitest row under its stored name', () => {
    expect(readReplayStatus('vitest', vitest, stored)).toBe('failed');
  });

  it('finds the Playwright row under its stored name', () => {
    const report = JSON.stringify({
      suites: [],
      errors: [loadError('/ci/checkout/ts/e2e/bad.spec.ts')],
    });
    expect(readReplayStatus('playwright', report, stored)).toBe('failed');
  });

  it('does not match a different file with the same suffix', () => {
    const other = {
      testName: `other/bad.spec.ts ${SUFFIX}`,
      file: 'other/bad.spec.ts',
      root: '/ci/checkout',
    };
    expect(readReplayStatus('vitest', vitest, other)).toBeNull();
  });

  it('does not match a path that merely ends with the stored name', () => {
    const suffixOnly = {
      testName: `e/bad.spec.ts ${SUFFIX}`,
      file: 'e/bad.spec.ts',
      root: '/ci/checkout',
    };
    expect(readReplayStatus('vitest', vitest, suffixOnly)).toBeNull();
  });

  it('does not loosen the match for a real test name', () => {
    const report = JSON.stringify({
      testResults: [
        {
          name: 'a.test.ts',
          assertionResults: [{ fullName: 'suite a works', status: 'failed' }],
        },
      ],
    });
    const real = {
      testName: 'a works',
      file: 'a.test.ts',
      root: '/ci/checkout',
    };
    expect(readReplayStatus('vitest', report, real)).toBeNull();
  });
});
