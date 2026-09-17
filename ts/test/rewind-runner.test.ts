/**
 * `canary rewind` runner half (#461 PR 2): the command that reruns one
 * recorded test, and reading its status back out of the runner's own report.
 */

import { describe, expect, it } from 'vitest';

import {
  readReplayStatus,
  replayCommand,
} from '../src/analysis/rewind/runner.js';

describe('replayCommand: vitest', () => {
  const base = {
    runner: 'vitest' as const,
    file: 'test/a.test.ts',
    testName: 'math adds (1+1)',
    seed: null,
    predecessors: [],
    reportPath: '/tmp/r.json',
  };

  it('runs the whole file with a JSON report and no name filter', () => {
    const cmd = replayCommand(base);
    expect(cmd.command).toBe('npx');
    expect(cmd.args).toEqual([
      'vitest',
      'run',
      'test/a.test.ts',
      '--reporter=json',
      '--outputFile=/tmp/r.json',
    ]);
    expect(cmd.seedApplied).toBe(false);
  });

  it('passes a recorded seed and says it did', () => {
    const cmd = replayCommand({ ...base, seed: '42' });
    expect(cmd.args).toContain('--sequence.seed=42');
    expect(cmd.seedApplied).toBe(true);
  });

  it('with predecessors runs their files first, serially', () => {
    const cmd = replayCommand({ ...base, predecessors: ['test/0.test.ts'] });
    expect(cmd.args.slice(2, 4)).toEqual(['test/0.test.ts', 'test/a.test.ts']);
    expect(cmd.args).toContain('--no-file-parallelism');
  });
});

describe('replayCommand: playwright', () => {
  const base = {
    runner: 'playwright' as const,
    file: 'e2e/checkout.spec.ts',
    testName: 'checkout > adds an item [chromium]',
    seed: '7',
    predecessors: [],
    reportPath: '/tmp/p.json',
  };

  it('greps the last title, pins the project, and never claims a seed', () => {
    const cmd = replayCommand(base);
    expect(cmd.args).toEqual([
      'playwright',
      'test',
      'e2e/checkout.spec.ts',
      '--reporter=json',
      '--project',
      'chromium',
      '--grep',
      'adds an item',
    ]);
    expect(cmd.env).toEqual({ PLAYWRIGHT_JSON_OUTPUT_NAME: '/tmp/p.json' });
    expect(cmd.seedApplied).toBe(false);
  });

  it('with predecessors runs one worker and no grep', () => {
    const cmd = replayCommand({ ...base, predecessors: ['e2e/login.spec.ts'] });
    expect(cmd.args).toContain('--workers=1');
    expect(cmd.args).not.toContain('--grep');
  });
});

describe('readReplayStatus', () => {
  it('reads the named vitest test status', () => {
    const report = JSON.stringify({
      testResults: [
        {
          name: '/w/test/a.test.ts',
          assertionResults: [
            { fullName: 'other', status: 'passed' },
            { fullName: 'math adds', status: 'failed' },
          ],
        },
      ],
    });
    expect(readReplayStatus('vitest', report, 'math adds')).toBe('failed');
  });

  it('reads the named Playwright test status, project suffix included', () => {
    const report = JSON.stringify({
      suites: [
        {
          title: 'checkout.spec.ts',
          file: 'checkout.spec.ts',
          suites: [
            {
              title: 'checkout',
              specs: [
                {
                  title: 'adds an item',
                  tests: [
                    {
                      projectName: 'chromium',
                      status: 'unexpected',
                      results: [{ status: 'failed' }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(
      readReplayStatus(
        'playwright',
        report,
        'checkout.spec.ts > checkout > adds an item [chromium]',
      ),
    ).toBe('failed');
  });

  it('returns null when the test is absent or the report is unreadable', () => {
    expect(
      readReplayStatus('vitest', '{"testResults":[]}', 'math adds'),
    ).toBeNull();
    expect(readReplayStatus('vitest', 'not json', 'math adds')).toBeNull();
  });
});
