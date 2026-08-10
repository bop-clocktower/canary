/**
 * Branch coverage for `canary history` (#481).
 *
 * `history-cli.test.ts` drives the sub-app through the main CLI against a real
 * on-disk NDJSON store, which can only reach the empty/abstaining shapes. These
 * tests drive {@link createHistoryCommand} directly with an injected fake store,
 * so the POPULATED render paths — the flaky table, the timeline table, the
 * pass-rate colour ladder, and the migrate loop's per-field fallbacks — are
 * exercised and asserted on their real output, not merely executed.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CliExit } from '../src/cli-common.js';
import { createHistoryCommand, type HistoryDeps } from '../src/history/cli.js';
import type { AsyncHistoryStore } from '../src/history/store.js';
import type {
  FlakyQueryRow,
  SummaryResult,
} from '../src/history/ndjson-store.js';
import type { TimelineEntry } from '../src/history/record.js';
import type { RunInput, TestResultInput } from '../src/history/schema.js';

interface FakeStoreConfig {
  countRuns?: number;
  flaky?: FlakyQueryRow[];
  timeline?: TimelineEntry[];
  summary?: SummaryResult;
}

interface PushedRun {
  run: RunInput;
  results: TestResultInput[];
}

function makeFakeStore(
  cfg: FakeStoreConfig,
  pushed: PushedRun[],
): AsyncHistoryStore {
  const store: AsyncHistoryStore = {
    pushRun: async (run, results) => {
      pushed.push({ run, results });
    },
    queryFlaky: async () => cfg.flaky ?? [],
    queryTimeline: async () => cfg.timeline ?? [],
    querySummary: async (suite) =>
      cfg.summary ?? { suite, total_runs: 0, avg_pass_rate: 0 },
  };
  // `countRuns` is OPTIONAL on the contract: leaving it off is the
  // "unknown denominator, never abstain" backend (see abstainOnEmptyHistory).
  if (cfg.countRuns !== undefined) {
    store.countRuns = async () => cfg.countRuns!;
  }
  return store;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  pushed: PushedRun[];
}

/** Invoke the `history` sub-app in-process with a fake store. */
async function runHistory(
  args: string[],
  cfg: FakeStoreConfig = {},
): Promise<RunResult> {
  const out: string[] = [];
  const err: string[] = [];
  const pushed: PushedRun[] = [];
  const deps: Partial<HistoryDeps> = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    env: {},
    makeStore: () => makeFakeStore(cfg, pushed),
  };
  let code = 0;
  try {
    await createHistoryCommand(deps).parseAsync(args, { from: 'user' });
  } catch (e) {
    if (e instanceof CliExit) code = e.code;
    else throw e;
  }
  return {
    code,
    stdout: strip(out.join('\n')),
    stderr: strip(err.join('\n')),
    pushed,
  };
}

function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function flakyRow(over: Partial<FlakyQueryRow> = {}): FlakyQueryRow {
  return {
    test_name: 'checkout renders',
    test_file: 'tests/checkout.spec.ts',
    suite: 'e2e',
    area: 'checkout',
    flake_count: 3,
    pass_count: 7,
    fail_count: 0,
    total_runs: 10,
    last_seen_run: 'run-9',
    flake_rate_pct: 30,
    ...over,
  };
}

function timelineRow(over: Partial<TimelineEntry> = {}): TimelineEntry {
  return {
    run_id: 'run-1',
    suite: 'e2e',
    branch: 'main',
    commit_sha: 'abcdef1234567890',
    timestamp: '2026-08-01T12:34:56.789Z',
    status: 'passed',
    failure_category: null,
    error_text: null,
    retry_count: 0,
    ...over,
  };
}

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), 'canary-hist-'));
}

describe('history flaky (populated store)', () => {
  it('renders a table row per flaky test with a Python-style rate', async () => {
    const res = await runHistory(['flaky'], {
      countRuns: 10,
      flaky: [flakyRow()],
    });
    expect(res.code).toBe(0);
    // pyFloat: a whole-number rate must render `30.0%`, not `30%`.
    expect(res.stdout).toContain('30.0%');
    expect(res.stdout).toContain('checkout renders');
    expect(res.stdout).toContain('3/10');
    expect(res.stdout).toContain('Flaky Tests (window: 30 runs');
  });

  it('renders an em-dash for a row with no area', async () => {
    const res = await runHistory(['flaky'], {
      countRuns: 10,
      flaky: [flakyRow({ area: null })],
    });
    expect(res.stdout).toContain('\u{2014}');
  });

  it('honours --window and --min-rate in the table header', async () => {
    const res = await runHistory(
      ['flaky', '--window', '5', '--min-rate', '2.5'],
      { countRuns: 10, flaky: [flakyRow()] },
    );
    expect(res.stdout).toContain('window: 5 runs');
    expect(res.stdout).toContain('\u{2265} 2.5%');
  });

  it('reports a clean result (not an abstention) over a populated store', async () => {
    const res = await runHistory(['flaky'], { countRuns: 42, flaky: [] });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('No tests above 10.0% flake rate');
    expect(res.stdout).not.toContain('runs recorded');
  });

  it('--json over a populated store emits the rows, not an abstention', async () => {
    const res = await runHistory(['flaky', '--json'], {
      countRuns: 10,
      flaky: [flakyRow()],
    });
    const rows = JSON.parse(res.stdout) as FlakyQueryRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.test_name).toBe('checkout renders');
    expect(res.stderr).toBe('');
  });

  it('--json abstains to stderr with an empty array on an empty store', async () => {
    const res = await runHistory(['flaky', '--json'], {
      countRuns: 0,
      flaky: [],
    });
    expect(JSON.parse(res.stdout)).toEqual([]);
    expect(res.stderr).toContain('No runs recorded');
    expect(res.stderr).toContain('flake rate');
  });

  it('does not abstain when the backend cannot report a run count', async () => {
    // countRuns absent == UNKNOWN denominator, which is not a zero one.
    const res = await runHistory(['flaky'], { flaky: [] });
    expect(res.stdout).toContain('No tests above');
    expect(res.stdout).not.toContain('No runs recorded');
  });
});

describe('history timeline (populated store)', () => {
  it('truncates the commit to 8 chars and the timestamp to seconds', async () => {
    const res = await runHistory(['timeline', 'checkout renders'], {
      countRuns: 3,
      timeline: [timelineRow()],
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Timeline: checkout renders');
    expect(res.stdout).toContain('abcdef12');
    expect(res.stdout).not.toContain('abcdef1234567890');
    expect(res.stdout).toContain('2026-08-01T12:34:56');
    expect(res.stdout).not.toContain('.789Z');
  });

  it('renders an em-dash for a row with no failure category', async () => {
    const res = await runHistory(['timeline', 't'], {
      countRuns: 1,
      timeline: [timelineRow({ failure_category: null })],
    });
    expect(res.stdout).toContain('\u{2014}');
  });

  it('renders the failure category when the run failed', async () => {
    const res = await runHistory(['timeline', 't'], {
      countRuns: 1,
      timeline: [
        timelineRow({ status: 'failed', failure_category: 'timeout' }),
      ],
    });
    expect(res.stdout).toContain('failed');
    expect(res.stdout).toContain('timeout');
  });

  it('distinguishes "no rows for this test" from "no runs at all"', async () => {
    const populated = await runHistory(['timeline', 'ghost'], {
      countRuns: 5,
      timeline: [],
    });
    expect(populated.stdout).toContain('No history found for: ghost');

    const empty = await runHistory(['timeline', 'ghost'], { countRuns: 0 });
    expect(empty.stdout).toContain('No runs recorded');
    expect(empty.stdout).toContain('the timeline for ghost');
    expect(empty.stdout).not.toContain('No history found for');
  });

  it('--json emits the timeline rows', async () => {
    const res = await runHistory(['timeline', 't', '--json'], {
      countRuns: 1,
      timeline: [timelineRow()],
    });
    const rows = JSON.parse(res.stdout) as TimelineEntry[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.run_id).toBe('run-1');
  });
});

describe('history summary (populated store)', () => {
  const cases: [number, string][] = [
    [97.5, '97.5%'],
    [80, '80.0%'],
    [12.5, '12.5%'],
  ];
  for (const [avg, rendered] of cases) {
    it(`renders an avg pass rate of ${avg} as ${rendered}`, async () => {
      const res = await runHistory(['summary', 'e2e'], {
        summary: { suite: 'e2e', total_runs: 8, avg_pass_rate: avg },
      });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('Suite e2e');
      expect(res.stdout).toContain('last 8 runs');
      expect(res.stdout).toContain(rendered);
    });
  }

  it('--json emits the raw summary without an abstention marker', async () => {
    const res = await runHistory(['summary', 'e2e', '--json', '--runs', '3'], {
      summary: { suite: 'e2e', total_runs: 3, avg_pass_rate: 91 },
    });
    const obj = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(obj['total_runs']).toBe(3);
    expect(obj).not.toHaveProperty('abstained');
  });

  it('--json marks an empty suite as abstained rather than 0%', async () => {
    const res = await runHistory(['summary', 'ghost', '--json'], {
      summary: { suite: 'ghost', total_runs: 0, avg_pass_rate: 0 },
    });
    const obj = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(obj['abstained']).toBe(true);
    expect(res.stderr).toContain('unknown -- not 0%');
  });
});

describe('history push', () => {
  it('pushes the LAST record in the file and filters to known fields', async () => {
    const tmp = mkTmp();
    try {
      const path = join(tmp, 'history.jsonl');
      const mkRecord = (id: string): Record<string, unknown> => ({
        run_id: id,
        suite: 'api',
        repo: 'a/b',
        branch: 'main',
        commit_sha: 'cafe',
        timestamp: '2026-08-01T00:00:00Z',
        total: 1,
        passed: 1,
        failed: 0,
        flaky: 0,
        skipped: 0,
        not_a_run_field: 'dropped',
        tests: [
          {
            run_id: id,
            suite: 'api',
            repo: 'a/b',
            test_name: 't',
            test_file: 'f',
            status: 'passed',
            not_a_result_field: 'dropped',
          },
        ],
      });
      writeFileSync(
        path,
        `${JSON.stringify(mkRecord('run-old'))}\n\n${JSON.stringify(mkRecord('run-new'))}\n`,
        'utf-8',
      );
      const res = await runHistory(['push', path]);
      expect(res.code).toBe(0);
      expect(res.pushed).toHaveLength(1);
      expect(res.pushed[0]!.run.run_id).toBe('run-new');
      expect(res.pushed[0]!.run).not.toHaveProperty('not_a_run_field');
      expect(res.pushed[0]!.run).not.toHaveProperty('tests');
      expect(res.pushed[0]!.results).toHaveLength(1);
      expect(res.pushed[0]!.results[0]).not.toHaveProperty(
        'not_a_result_field',
      );
      expect(res.stdout).toContain('Pushed run run-new (1 tests)');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('treats a record with no tests key as zero results', async () => {
    const tmp = mkTmp();
    try {
      const path = join(tmp, 'history.jsonl');
      writeFileSync(path, `${JSON.stringify({ run_id: 'r1' })}\n`, 'utf-8');
      const res = await runHistory(['push', path]);
      expect(res.code).toBe(0);
      expect(res.pushed[0]!.results).toEqual([]);
      expect(res.stdout).toContain('(0 tests)');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('--dry-run reports the run without pushing it', async () => {
    const tmp = mkTmp();
    try {
      const path = join(tmp, 'history.jsonl');
      writeFileSync(path, `${JSON.stringify({ run_id: 'r1' })}\n`, 'utf-8');
      const res = await runHistory(['push', path, '--dry-run']);
      expect(res.code).toBe(0);
      expect(res.pushed).toEqual([]);
      expect(res.stdout).toContain('dry-run: would push run r1');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('exits 0 with a notice when the file holds no records', async () => {
    const tmp = mkTmp();
    try {
      const path = join(tmp, 'history.jsonl');
      writeFileSync(path, '\n\n  \n', 'utf-8');
      const res = await runHistory(['push', path]);
      expect(res.code).toBe(0);
      expect(res.pushed).toEqual([]);
      expect(res.stdout).toContain('No runs found in history file.');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('history migrate', () => {
  it('migrates a v1 record and carries its aggregate counts through', async () => {
    const tmp = mkTmp();
    try {
      const path = join(tmp, 'v1.jsonl');
      writeFileSync(
        path,
        `${JSON.stringify({
          commit_short: 'abc1234',
          timestamp: '2026-08-01T00:00:00Z',
          branch: 'release',
          run: { total: 10, passed: 8, failed: 1, flaky: 1, skipped: 0 },
        })}\n`,
        'utf-8',
      );
      const res = await runHistory([
        'migrate',
        path,
        '--suite',
        'api',
        '--repo',
        'a/b',
      ]);
      expect(res.code).toBe(0);
      expect(res.pushed).toHaveLength(1);
      const run = res.pushed[0]!.run;
      expect(run.suite).toBe('api');
      expect(run.repo).toBe('a/b');
      expect(run.branch).toBe('release');
      expect(run.commit_sha).toBe('abc1234');
      expect(run.total).toBe(10);
      expect(run.passed).toBe(8);
      expect(res.stdout).toContain('Migrated 1 runs, skipped 0');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('defaults every absent v1 field rather than emitting undefined', async () => {
    const tmp = mkTmp();
    try {
      const path = join(tmp, 'v1.jsonl');
      writeFileSync(path, '{}\n', 'utf-8');
      const res = await runHistory([
        'migrate',
        path,
        '--suite',
        'api',
        '--repo',
        'a/b',
      ]);
      expect(res.code).toBe(0);
      const run = res.pushed[0]!.run;
      expect(run.commit_sha).toBe('unknown');
      expect(run.branch).toBe('unknown');
      expect(run.timestamp).toBe('');
      expect(run.total).toBe(0);
      expect(run.skipped).toBe(0);
      // An unparseable timestamp falls back to "now", so the id is still unique.
      expect(run.run_id).toContain('api');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('skips malformed JSON lines but still migrates the valid ones', async () => {
    const tmp = mkTmp();
    try {
      const path = join(tmp, 'v1.jsonl');
      writeFileSync(path, 'not json\n\n{"commit_short":"aaa"}\n', 'utf-8');
      const res = await runHistory([
        'migrate',
        path,
        '--suite',
        'api',
        '--repo',
        'a/b',
      ]);
      expect(res.code).toBe(0);
      expect(res.pushed).toHaveLength(1);
      expect(res.stdout).toContain('Migrated 1 runs');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('--dry-run lists the run ids without pushing', async () => {
    const tmp = mkTmp();
    try {
      const path = join(tmp, 'v1.jsonl');
      writeFileSync(path, '{"commit_short":"aaa"}\n', 'utf-8');
      const res = await runHistory([
        'migrate',
        path,
        '--suite',
        'api',
        '--repo',
        'a/b',
        '--dry-run',
      ]);
      expect(res.code).toBe(0);
      expect(res.pushed).toEqual([]);
      expect(res.stdout).toContain('dry-run:');
      expect(res.stdout).toContain('Migrated 1 runs');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('abstains rather than reporting a green "Migrated 0 runs"', async () => {
    const tmp = mkTmp();
    try {
      const path = join(tmp, 'v1.jsonl');
      writeFileSync(path, 'garbage\n', 'utf-8');
      const res = await runHistory([
        'migrate',
        path,
        '--suite',
        'api',
        '--repo',
        'a/b',
      ]);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('could be migrated');
      expect(res.stdout).not.toContain('Migrated 0 runs');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('exits 1 when the file is missing', async () => {
    const tmp = mkTmp();
    try {
      const res = await runHistory([
        'migrate',
        join(tmp, 'nope.jsonl'),
        '--suite',
        'api',
        '--repo',
        'a/b',
      ]);
      expect(res.code).toBe(1);
      expect(res.stdout).toContain('Not found:');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('history table alignment', () => {
  it('pads every column to its widest cell so rows line up', async () => {
    const res = await runHistory(['timeline', 't'], {
      countRuns: 2,
      timeline: [
        timelineRow({ run_id: 'r', status: 'passed' }),
        timelineRow({ run_id: 'a-much-longer-run-id', status: 'failed' }),
      ],
    });
    const lines = res.stdout.split('\n');
    const header = lines.findIndex((l) => l.startsWith('Run ID'));
    expect(header).toBeGreaterThanOrEqual(0);
    const widths = lines
      .slice(header, header + 4)
      .map((l) => l.trimEnd().length);
    // The separator rule and the widest data row share the same total width.
    expect(widths[1]).toBe(Math.max(...widths));
  });
});

describe('history defaults', () => {
  it('resolves a real store when no factory is injected', async () => {
    const tmp = mkTmp();
    try {
      mkdirSync(join(tmp, 'test-results', 'reports'), { recursive: true });
      const cmd = createHistoryCommand({
        out: () => {},
        err: () => {},
        env: {},
      });
      // No makeStore override: the production factory must produce a store the
      // command can query without throwing.
      await expect(
        cmd.parseAsync(['summary', 'nothing-here', '--json'], { from: 'user' }),
      ).resolves.toBeDefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
