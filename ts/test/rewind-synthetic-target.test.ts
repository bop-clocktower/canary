/**
 * Replaying a failure outside any test (#1411), the row that exists only when
 * the file fails. Report shapes here copy real Playwright 1.64.1 and vitest
 * runs, with paths shortened. What those runs showed, which the cases pin:
 *
 *   - A file that loads cleanly has NO synthetic row, so "no row" must read as
 *     `passed` or a repeat count can never say `intermittent`.
 *   - That reading needs proof the file ran. Playwright's `a.spec.ts` argument
 *     also selects `sub/a.spec.ts`, whose load error aborts the run with empty
 *     `suites`, and then nothing is known about `a.spec.ts`.
 *   - A `--grep` on the synthetic title matches no test, so a clean file reports
 *     `No tests found` with empty `suites`: the command must not grep.
 */

import { describe, expect, it } from 'vitest';

import {
  readReplayStatus,
  replayCommand,
  type ReplayRunner,
} from '../src/analysis/rewind/runner.js';

const SUFFIX = ' (file failed outside any test)';
const ROOT = '/wt';

const target = (file: string, tail = SUFFIX) => ({
  testName: `${file}${tail}`,
  file,
  root: ROOT,
});

const pwError = (file: string) => ({
  message: 'Error: boom at load',
  location: { file, line: 2, column: 7 },
});

const NO_TESTS = {
  message:
    'Error: No tests found.\nMake sure that arguments are regular expressions matching test files.\nYou may need to escape symbols like "$" or "*" and quote the arguments.',
};

const pwSuite = (file: string) => ({
  title: file,
  file,
  specs: [
    {
      title: 'adds',
      tests: [{ status: 'expected', results: [{ status: 'passed' }] }],
    },
  ],
});

const playwright = (over: object, rootDir: string | null = ROOT) =>
  JSON.stringify({
    ...(rootDir === null ? {} : { config: { rootDir } }),
    suites: [],
    errors: [],
    ...over,
  });

const vitestFile = (name: string, message?: string) => ({
  name,
  status: message === undefined ? 'passed' : 'failed',
  message: message ?? '',
  assertionResults: [],
});

const vitest = (...files: object[]) => JSON.stringify({ testResults: files });

const read = (runner: ReplayRunner, report: string, t = target('a.spec.ts')) =>
  readReplayStatus(runner, report, t);

describe('M1: another file with the same tail never answers for the target', () => {
  it('Playwright: an error at sub/a.spec.ts says nothing about a.spec.ts', () => {
    const report = playwright({ errors: [pwError('/wt/sub/a.spec.ts')] });
    expect(read('playwright', report)).toBeNull();
  });

  it('vitest: pkg/a.test.ts failing does not fail a clean a.test.ts', () => {
    const report = vitest(
      vitestFile('/wt/pkg/a.test.ts', 'boom'),
      vitestFile('/wt/a.test.ts'),
    );
    expect(read('vitest', report, target('a.test.ts'))).toBe('passed');
  });

  it('a monorepo name: only the exact file under the root counts', () => {
    const t = target('test/index.test.ts');
    const report = vitest(
      vitestFile('/wt/packages/x/test/index.test.ts', 'boom'),
    );
    expect(read('vitest', report, t)).toBeNull();
  });

  it('a different checkout holding the same path does not count', () => {
    const report = vitest(vitestFile('/elsewhere/a.test.ts', 'boom'));
    expect(read('vitest', report, target('a.test.ts'))).toBeNull();
  });

  it('still finds the target itself when both files failed', () => {
    const report = playwright({
      errors: [pwError('/wt/sub/a.spec.ts'), pwError('/wt/a.spec.ts')],
    });
    expect(read('playwright', report)).toBe('failed');
  });

  it('finds a numbered row at its own file', () => {
    const report = playwright({
      errors: [pwError('/wt/a.spec.ts'), pwError('/wt/a.spec.ts')],
    });
    const second = target('a.spec.ts', `${SUFFIX} #2`);
    expect(read('playwright', report, second)).toBe('failed');
  });

  it('finds a row stored before the name became repo-relative', () => {
    const old = {
      testName: `/old/checkout/test/a.spec.ts${SUFFIX}`,
      file: 'test/a.spec.ts',
      root: ROOT,
    };
    const report = playwright({ errors: [pwError('/wt/test/a.spec.ts')] });
    expect(read('playwright', report, old)).toBe('failed');
  });
});

describe('M2: a clean attempt is a counted pass, when the file provably ran', () => {
  it('vitest: the file ran with no failure outside a test', () => {
    const report = vitest(vitestFile('/wt/a.test.ts'));
    expect(read('vitest', report, target('a.test.ts'))).toBe('passed');
  });

  it('vitest: a test failing inside the file is not the load failure', () => {
    const report = vitest({
      name: '/wt/a.test.ts',
      status: 'failed',
      message: '',
      assertionResults: [{ fullName: 'adds', status: 'failed' }],
    });
    expect(read('vitest', report, target('a.test.ts'))).toBe('passed');
  });

  it('Playwright: the file is listed under the report rootDir', () => {
    const report = playwright({ suites: [pwSuite('a.spec.ts')] });
    expect(read('playwright', report)).toBe('passed');
  });

  it('Playwright: a testDir below the checkout still resolves the file', () => {
    const t = target('e2e/a.spec.ts');
    const report = playwright(
      { suites: [pwSuite('a.spec.ts')] },
      `${ROOT}/e2e`,
    );
    expect(read('playwright', report, t)).toBe('passed');
  });

  it('a second error that did not recur is not a failure of that row', () => {
    const report = playwright({
      suites: [pwSuite('a.spec.ts')],
    });
    const second = target('a.spec.ts', `${SUFFIX} #2`);
    expect(read('playwright', report, second)).toBe('passed');
  });

  it.each([
    [
      'the file was not selected',
      playwright({ suites: [pwSuite('sub/a.spec.ts')] }),
    ],
    ['nothing was found', playwright({ errors: [NO_TESTS] })],
    [
      'another file aborted the run',
      playwright({ errors: [pwError('/wt/sub/a.spec.ts')] }),
    ],
    [
      'the report has no rootDir to resolve against',
      playwright({ suites: [pwSuite('a.spec.ts')] }, null),
    ],
  ])('Playwright abstains when %s', (_label, report) => {
    expect(read('playwright', report)).toBeNull();
  });

  it('vitest abstains when the file is not in the report', () => {
    const report = vitest(vitestFile('/wt/sub/a.test.ts'));
    expect(read('vitest', report, target('a.test.ts'))).toBeNull();
  });

  it('an unreadable report abstains', () => {
    expect(read('vitest', 'not json', target('a.test.ts'))).toBeNull();
  });

  it('a real test absent from the report still abstains', () => {
    const real = { testName: 'adds', file: 'a.test.ts', root: ROOT };
    expect(
      read('vitest', vitest(vitestFile('/wt/a.test.ts')), real),
    ).toBeNull();
  });

  it('a real test merely titled like the suffix is not a synthetic target', () => {
    const real = {
      testName: `checks the wording${SUFFIX}`,
      file: 'a.test.ts',
      root: ROOT,
    };
    expect(
      read('vitest', vitest(vitestFile('/wt/a.test.ts')), real),
    ).toBeNull();
  });
});

describe('replayCommand: a synthetic target', () => {
  const spec = {
    runner: 'playwright' as const,
    file: 'a.spec.ts',
    seed: null,
    predecessors: [],
    reportPath: '/s/report.json',
  };

  it('runs the whole file: a grep would match no test and hide a clean load', () => {
    const cmd = replayCommand({ ...spec, testName: `a.spec.ts${SUFFIX}` });
    expect(cmd.args).not.toContain('--grep');
  });

  it('also for a numbered row', () => {
    const cmd = replayCommand({ ...spec, testName: `a.spec.ts${SUFFIX} #2` });
    expect(cmd.args).not.toContain('--grep');
  });

  it('still greps for a real test', () => {
    const cmd = replayCommand({ ...spec, testName: 'a.spec.ts > adds' });
    expect(cmd.args).toContain('--grep');
  });
});
