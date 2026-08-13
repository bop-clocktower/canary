/**
 * `canary history record` (#538) -- the first command in the product that
 * WRITES the history store.
 *
 * Two kinds of test here, deliberately:
 *   - end-to-end through the main CLI against a real on-disk NDJSON store, so
 *     the proof that a run was recorded is a later `history`/`analyze` read
 *     returning it, not an assertion about an internal call; and
 *   - the sub-app driven directly with a fake store (the `history-cli-branches`
 *     pattern) for the paths a real local store cannot reach -- a backend with
 *     no `countRuns()`, where duplicate detection has to say "cannot verify"
 *     rather than claim a write it did not confirm (ADR 0013).
 *
 * The abstention row lives in `gate-conformance.test.ts`; the control case (a
 * non-zero denominator still records) is here, per the new-gate checklist.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CliExitError } from '../src/cli-common.js';
import { EXIT_ABSTAINED } from '../src/core/gate-result.js';
import { createHistoryCommand, type HistoryDeps } from '../src/history/cli.js';
import type { AsyncHistoryStore } from '../src/history/store.js';
import type { RunInput, TestResultInput } from '../src/history/schema.js';
import {
  buildRunFromVitestReport,
  countReportResults,
  detectReportShape,
  RecordValidationError,
  validateBuiltRun,
  type BuiltRun,
} from '../src/history/run-recorder.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

const HISTORY_REL = join('test-results', 'reports', 'history-v2.jsonl');

/** A minimal vitest `--reporter=json` report with the given assertions. */
function vitestReport(
  assertions: {
    title: string;
    status: string;
    duration?: number;
    failureMessages?: string[];
  }[],
  file = 'test/checkout.test.ts',
): unknown {
  return {
    startTime: 1_754_000_000_000,
    testResults: [
      {
        name: file,
        assertionResults: assertions.map((a) => ({
          fullName: a.title,
          title: a.title,
          status: a.status,
          duration: a.duration ?? 5,
          ...(a.failureMessages ? { failureMessages: a.failureMessages } : {}),
        })),
      },
    ],
  };
}

function writeJson(path: string, value: unknown): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value), 'utf-8');
  return path;
}

/** Every recorded NDJSON line of the store under `cwd`. */
function readStore(cwd: string): Record<string, unknown>[] {
  return readFileSync(join(cwd, HISTORY_REL), 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const CI_ENV = {
  GITHUB_REPOSITORY: 'acme/widgets',
  GITHUB_REF_NAME: 'feat/x',
  GITHUB_SHA: 'deadbeefcafe1234',
};

describe('canary history record', () => {
  it('records a run the read side can then query', async () => {
    const tmp = mkTmp();
    try {
      const src = writeJson(
        join(tmp, 'vitest.json'),
        vitestReport([
          { title: 'checkout renders', status: 'passed' },
          {
            title: 'checkout totals',
            status: 'failed',
            failureMessages: ['x'],
          },
          { title: 'checkout coupon', status: 'skipped' },
        ]),
      );

      const res = await invokeCanary(
        ['history', 'record', src, '--suite', 'e2e'],
        { cwd: tmp, env: CI_ENV },
      );

      expect(res.code).toBe(0);
      expect(res.stdout).toContain('Recorded 3 result(s) for e2e');
      expect(res.stdout).toContain('1 passed, 1 failed, 1 skipped');

      const lines = readStore(tmp);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        suite: 'e2e',
        repo: 'acme/widgets',
        branch: 'feat/x',
        commit_sha: 'deadbeefcafe1234',
        total: 3,
        passed: 1,
        failed: 1,
        skipped: 1,
        flaky: 0,
      });

      // The proof that matters: the READ side sees it. Before this command
      // existed, `summary` could only ever abstain on canary's own store.
      const summary = await invokeCanary(
        ['history', 'summary', 'e2e', '--json'],
        { cwd: tmp, env: CI_ENV },
      );
      const parsed = JSON.parse(summary.stdout) as { total_runs: number };
      expect(parsed.total_runs).toBe(1);
      expect(summary.stdout).not.toContain('abstained');
    } finally {
      rmTmp(tmp);
    }
  });

  it('writes full per-test rows, so timeline resolves the recorded test', async () => {
    const tmp = mkTmp();
    try {
      const src = writeJson(
        join(tmp, 'vitest.json'),
        vitestReport([{ title: 'checkout renders', status: 'passed' }]),
      );
      await invokeCanary(['history', 'record', src, '--suite', 'e2e'], {
        cwd: tmp,
        env: CI_ENV,
      });

      const res = await invokeCanary(
        ['history', 'timeline', 'checkout renders', '--json'],
        { cwd: tmp, env: CI_ENV },
      );
      const rows = JSON.parse(res.stdout) as {
        suite: string;
        status: string;
      }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ suite: 'e2e', status: 'passed' });
    } finally {
      rmTmp(tmp);
    }
  });

  it('honours --path, --branch, --commit and --run-id over the env', async () => {
    const tmp = mkTmp();
    try {
      const src = writeJson(
        join(tmp, 'vitest.json'),
        vitestReport([{ title: 't', status: 'passed' }]),
      );
      const store = join(tmp, 'custom', 'history.jsonl');
      const res = await invokeCanary(
        [
          'history',
          'record',
          src,
          '--suite',
          'api',
          '--repo',
          'other/repo',
          '--branch',
          'release/9',
          '--commit',
          'abc123def456',
          '--run-id',
          'fixed-run-1',
          '--path',
          store,
        ],
        { cwd: tmp, env: CI_ENV },
      );

      expect(res.code).toBe(0);
      const rec = JSON.parse(readFileSync(store, 'utf-8').trim()) as Record<
        string,
        unknown
      >;
      expect(rec).toMatchObject({
        run_id: 'fixed-run-1',
        repo: 'other/repo',
        branch: 'release/9',
        commit_sha: 'abc123def456',
      });
    } finally {
      rmTmp(tmp);
    }
  });

  it('--json carries checked and abstained additively', async () => {
    const tmp = mkTmp();
    try {
      const src = writeJson(
        join(tmp, 'vitest.json'),
        vitestReport([{ title: 't', status: 'passed' }]),
      );
      const res = await invokeCanary(
        ['history', 'record', src, '--suite', 'api', '--json'],
        { cwd: tmp, env: CI_ENV },
      );
      expect(res.code).toBe(0);
      const payload = JSON.parse(res.stdout) as Record<string, unknown>;
      expect(payload).toMatchObject({
        suite: 'api',
        checked: 1,
        recorded: true,
        abstained: false,
      });
    } finally {
      rmTmp(tmp);
    }
  });

  it('--dry-run reports what it would record and writes nothing', async () => {
    const tmp = mkTmp();
    try {
      const src = writeJson(
        join(tmp, 'vitest.json'),
        vitestReport([{ title: 't', status: 'passed' }]),
      );
      const res = await invokeCanary(
        ['history', 'record', src, '--suite', 'api', '--dry-run'],
        { cwd: tmp, env: CI_ENV },
      );
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('dry-run:');
      expect(() => readStore(tmp)).toThrow();
    } finally {
      rmTmp(tmp);
    }
  });

  it('exits 1 when the results file is missing', async () => {
    const tmp = mkTmp();
    try {
      const res = await invokeCanary(
        ['history', 'record', join(tmp, 'nope.json'), '--suite', 'api'],
        { cwd: tmp, env: CI_ENV },
      );
      expect(res.code).toBe(1);
      expect(res.stdout).toContain('Not found:');
    } finally {
      rmTmp(tmp);
    }
  });

  it('exits 1 and names the file when the report is not parseable JSON', async () => {
    const tmp = mkTmp();
    try {
      const src = join(tmp, 'broken.json');
      writeFileSync(src, '{not json', 'utf-8');
      const res = await invokeCanary(
        ['history', 'record', src, '--suite', 'api'],
        { cwd: tmp, env: CI_ENV },
      );
      expect(res.code).toBe(1);
      expect(res.stdout).toContain('broken.json');
      expect(res.stdout.toLowerCase()).toContain('could not be read');
    } finally {
      rmTmp(tmp);
    }
  });

  it('refuses an unrecognized report shape and names what it does support', async () => {
    const tmp = mkTmp();
    try {
      // A Playwright JSON report: valid JSON, right domain, wrong shape. The
      // failure mode to avoid is recording zero results from it and calling
      // that a run.
      const src = writeJson(join(tmp, 'playwright.json'), {
        suites: [{ specs: [{ title: 'a', ok: true }] }],
      });
      const res = await invokeCanary(
        ['history', 'record', src, '--suite', 'e2e'],
        { cwd: tmp, env: CI_ENV },
      );
      expect(res.code).toBe(1);
      expect(res.stdout).toContain('vitest');
      expect(res.stdout).toContain('testResults');
      expect(() => readStore(tmp)).toThrow();
    } finally {
      rmTmp(tmp);
    }
  });

  it('exits 2 when the repo cannot be resolved, rather than inventing one', async () => {
    const tmp = mkTmp();
    try {
      const src = writeJson(
        join(tmp, 'vitest.json'),
        vitestReport([{ title: 't', status: 'passed' }]),
      );
      const res = await invokeCanary(
        ['history', 'record', src, '--suite', 'api'],
        { cwd: tmp, env: { GITHUB_REPOSITORY: undefined } },
      );
      expect(res.code).toBe(2);
      expect(res.stdout).toContain('--repo');
    } finally {
      rmTmp(tmp);
    }
  });

  it('refuses a duplicate run_id loudly instead of skipping it silently', async () => {
    const tmp = mkTmp();
    try {
      const src = writeJson(
        join(tmp, 'vitest.json'),
        vitestReport([{ title: 't', status: 'passed' }]),
      );
      const args = [
        'history',
        'record',
        src,
        '--suite',
        'api',
        '--run-id',
        'dup-1',
      ];
      const first = await invokeCanary(args, { cwd: tmp, env: CI_ENV });
      expect(first.code).toBe(0);

      const second = await invokeCanary(args, { cwd: tmp, env: CI_ENV });
      expect(second.code).toBe(1);
      expect(second.stdout).toContain('dup-1');
      expect(second.stdout.toLowerCase()).toContain('already recorded');
      // And nothing was appended.
      expect(readStore(tmp)).toHaveLength(1);
    } finally {
      rmTmp(tmp);
    }
  });

  it('defaults the suite name into the run id when none is given', async () => {
    const tmp = mkTmp();
    try {
      const src = writeJson(
        join(tmp, 'vitest.json'),
        vitestReport([{ title: 't', status: 'passed' }]),
      );
      const res = await invokeCanary(
        ['history', 'record', src, '--suite', 'api'],
        { cwd: tmp, env: CI_ENV },
      );
      expect(res.code).toBe(0);
      const rec = readStore(tmp)[0]!;
      expect(String(rec['run_id'])).toMatch(/^api-deadbeef-\d+$/);
    } finally {
      rmTmp(tmp);
    }
  });

  it('documents the flaky-vocabulary gap in its own output', async () => {
    const tmp = mkTmp();
    try {
      const src = writeJson(
        join(tmp, 'vitest.json'),
        vitestReport([{ title: 't', status: 'passed' }]),
      );
      const res = await invokeCanary(
        ['history', 'record', src, '--suite', 'api'],
        { cwd: tmp, env: CI_ENV },
      );
      // vitest has no `flaky` status, so a retried-then-passed test is recorded
      // as passed. That is a real hole in the data every flake report reads;
      // saying so in the output is cheaper than a reader inferring `flaky: 0`
      // means a clean fleet.
      expect(res.stdout.toLowerCase()).toContain('flaky');
      expect(res.stdout).toContain('retried');
    } finally {
      rmTmp(tmp);
    }
  });

  it('has help text naming the argument and every option', () => {
    const record = createHistoryCommand({
      out: () => {},
      err: () => {},
    }).commands.find((c) => c.name() === 'record');
    expect(record).toBeDefined();
    const help = record!.helpInformation().replace(/\s+/g, ' ');
    expect(record!.description()).not.toBe('');
    for (const flag of [
      '--suite',
      '--repo',
      '--branch',
      '--commit',
      '--path',
      '--run-id',
      '--dry-run',
      '--json',
    ]) {
      expect(help).toContain(flag);
    }
    expect(help).toContain('results_file');
  });
});

// --- the validator, directly --------------------------------------------------

describe('validateBuiltRun', () => {
  const ctx = {
    suite: 'api',
    repo: 'acme/widgets',
    branch: 'main',
    commitSha: 'abcdef1234',
    nowMs: 1_754_000_000_000,
  };

  function built(): BuiltRun {
    return buildRunFromVitestReport(
      vitestReport([{ title: 't', status: 'passed' }]),
      ctx,
    );
  }

  it('accepts a run built from a well-formed report', () => {
    expect(() => validateBuiltRun(built())).not.toThrow();
  });

  it('rejects an empty run-level field', () => {
    const b = built();
    b.run.repo = '';
    expect(() => validateBuiltRun(b)).toThrow(RecordValidationError);
    expect(() => validateBuiltRun(b)).toThrow(/'repo' is empty/);
  });

  it('rejects a status outside the canary vocabulary', () => {
    const b = built();
    b.results[0]!.status = 'pending';
    expect(() => validateBuiltRun(b)).toThrow(/passed\|failed\|flaky\|skipped/);
  });

  it('rejects a total that disagrees with the recorded rows', () => {
    const b = built();
    b.run.total = 7;
    expect(() => validateBuiltRun(b)).toThrow(/disagrees with 1 recorded/);
  });

  it('rejects status counts that do not sum to the total', () => {
    const b = built();
    b.run.passed = 0;
    expect(() => validateBuiltRun(b)).toThrow(/do not sum to the total/);
  });

  it('treats a non-object document as an unrecognized shape', () => {
    expect(detectReportShape(null)).toBe('unknown');
    expect(detectReportShape('a string')).toBe('unknown');
    expect(detectReportShape({ testResults: 'not an array' })).toBe('unknown');
  });

  it('counts results without needing any run-level fact', () => {
    expect(countReportResults({ testResults: [] })).toBe(0);
    expect(countReportResults({ testResults: [{ name: 'a' }] })).toBe(0);
    expect(
      countReportResults(vitestReport([{ title: 't', status: 'passed' }])),
    ).toBe(1);
  });

  it('falls back to the injected clock when the report has no startTime', () => {
    const b = buildRunFromVitestReport(
      {
        testResults: [
          { name: 'a', assertionResults: [{ title: 't', status: 'passed' }] },
        ],
      },
      { ...ctx, nowMs: 1_700_000_000_000 },
    );
    expect(b.run.run_id).toBe('api-abcdef12-1700000000');
  });
});

// --- fake-store paths a real local store cannot reach ------------------------

interface Pushed {
  run: RunInput;
  results: TestResultInput[];
}

/** A store WITHOUT `countRuns` -- the unknown-denominator backend (ADR 0013). */
function storeWithoutCountRuns(pushed: Pushed[]): AsyncHistoryStore {
  return {
    pushRun: async (run, results) => {
      pushed.push({ run, results });
    },
    queryFlaky: async () => [],
    queryTimeline: async () => [],
    querySummary: async (suite) => ({
      suite,
      total_runs: 0,
      avg_pass_rate: 0,
    }),
  };
}

async function runRecord(
  args: string[],
  store: AsyncHistoryStore,
  env: Record<string, string | undefined> = CI_ENV,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const deps: Partial<HistoryDeps> = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    env: env as NodeJS.ProcessEnv,
    makeStore: () => store,
  };
  let code = 0;
  try {
    await createHistoryCommand(deps).parseAsync(args, { from: 'user' });
  } catch (e) {
    if (e instanceof CliExitError) code = e.code;
    else throw e;
  }
  const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
  return { code, stdout: strip(out.join('\n')), stderr: strip(err.join('\n')) };
}

describe('canary history record (backend degradations)', () => {
  it('says duplicate detection is unavailable when the backend cannot count runs', async () => {
    const tmp = mkTmp();
    try {
      const src = writeJson(
        join(tmp, 'vitest.json'),
        vitestReport([{ title: 't', status: 'passed' }]),
      );
      const pushed: Pushed[] = [];
      const res = await runRecord(
        ['record', src, '--suite', 'api'],
        storeWithoutCountRuns(pushed),
      );
      expect(res.code).toBe(0);
      expect(pushed).toHaveLength(1);
      // Cannot verify is a finding, not a silence.
      expect(res.stderr.toLowerCase()).toContain('could not be verified');
    } finally {
      rmTmp(tmp);
    }
  });

  it('records into the configured remote backend, not the local file', async () => {
    const tmp = mkTmp();
    try {
      const src = writeJson(
        join(tmp, 'vitest.json'),
        vitestReport([{ title: 't', status: 'passed' }]),
      );
      const pushed: Pushed[] = [];
      const res = await runRecord(
        ['record', src, '--suite', 'api', '--db-url', 'https://db.example'],
        storeWithoutCountRuns(pushed),
      );
      expect(res.code).toBe(0);
      expect(pushed[0]!.run.suite).toBe('api');
      expect(pushed[0]!.results).toHaveLength(1);
      expect(pushed[0]!.results[0]).toMatchObject({
        test_name: 't',
        status: 'passed',
        suite: 'api',
        repo: 'acme/widgets',
      });
    } finally {
      rmTmp(tmp);
    }
  });

  it('says --path is unused when a db-url is configured', async () => {
    const tmp = mkTmp();
    try {
      const src = writeJson(
        join(tmp, 'vitest.json'),
        vitestReport([{ title: 't', status: 'passed' }]),
      );
      const res = await runRecord(
        [
          'record',
          src,
          '--suite',
          'api',
          '--db-url',
          'https://db.example',
          '--path',
          join(tmp, 'ignored.jsonl'),
        ],
        storeWithoutCountRuns([]),
      );
      expect(res.code).toBe(0);
      expect(res.stderr).toContain('--path is ignored');
    } finally {
      rmTmp(tmp);
    }
  });

  it('abstains with exit 3 on a report carrying zero results', async () => {
    const tmp = mkTmp();
    try {
      const src = writeJson(join(tmp, 'empty.json'), {
        startTime: 1,
        testResults: [],
      });
      const pushed: Pushed[] = [];
      const res = await runRecord(
        ['record', src, '--suite', 'api'],
        storeWithoutCountRuns(pushed),
      );
      expect(res.code).toBe(EXIT_ABSTAINED);
      expect(res.stdout.toLowerCase()).toContain('abstained');
      expect(pushed).toHaveLength(0);
    } finally {
      rmTmp(tmp);
    }
  });

  it('abstains on --json with the notice on stderr and a parseable payload', async () => {
    const tmp = mkTmp();
    try {
      const src = writeJson(join(tmp, 'empty.json'), {
        startTime: 1,
        testResults: [{ name: 'a.test.ts', assertionResults: [] }],
      });
      const res = await runRecord(
        ['record', src, '--suite', 'api', '--json'],
        storeWithoutCountRuns([]),
      );
      expect(res.code).toBe(EXIT_ABSTAINED);
      const payload = JSON.parse(res.stdout) as Record<string, unknown>;
      expect(payload).toMatchObject({
        checked: 0,
        recorded: false,
        abstained: true,
      });
      expect(res.stderr.toLowerCase()).toContain('abstained');
    } finally {
      rmTmp(tmp);
    }
  });

  it('rejects a report whose per-test rows are internally inconsistent', async () => {
    const tmp = mkTmp();
    try {
      // A row with no name at all: the store has no key to join on, and a
      // malformed record poisons every later report that reads the file.
      const src = writeJson(join(tmp, 'vitest.json'), {
        startTime: 1,
        testResults: [
          {
            name: 'a.test.ts',
            assertionResults: [{ status: 'passed', duration: 1 }],
          },
        ],
      });
      const pushed: Pushed[] = [];
      const res = await runRecord(
        ['record', src, '--suite', 'api'],
        storeWithoutCountRuns(pushed),
      );
      expect(res.code).toBe(1);
      expect(res.stdout.toLowerCase()).toContain('invalid');
      expect(pushed).toHaveLength(0);
    } finally {
      rmTmp(tmp);
    }
  });
});
