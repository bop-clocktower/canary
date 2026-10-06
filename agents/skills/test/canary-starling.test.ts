import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  historyToRun,
  RUNS_PER_SUITE,
  selectRuns,
} from '../claude-code/canary-starling/scripts/runs.mjs';
import { flakyTests } from '../claude-code/canary-starling/scripts/flaky.mjs';
import { registerRows } from '../claude-code/canary-starling/scripts/register.mjs';
import {
  ciReadyAssessments,
  CI_READY_METRICS,
  latestPerKey,
} from '../claude-code/canary-starling/scripts/assess.mjs';
import {
  composeFeed,
  parseConfig,
} from '../claude-code/canary-starling/scripts/feed.mjs';
import { main as starlingMain } from '../claude-code/canary-starling/scripts/cli.mjs';
import { validateDocument } from '../lib/contracts/validate.mjs';

const SCOPE = { id: 'canary', env: 'ci' };

const historyRow = (over: Record<string, unknown> = {}) => ({
  run_id: 'r1',
  suite: 'ts-engine',
  branch: 'main',
  commit_sha: 'abc1234',
  timestamp: '2026-10-06T10:00:00Z',
  duration_ms: 60000,
  total: 2,
  passed: 1,
  failed: 1,
  flaky: 0,
  skipped: 0,
  schema_version: 3,
  tests: [
    { test_name: 'a', test_file: 'test/a.test.ts', status: 'passed' },
    {
      test_name: 'b',
      test_file: 'test/b.test.ts',
      status: 'failed',
      error_text: 'boom',
    },
  ],
  ...over,
});

// historyToRun returns {run: null} for a left-out row; narrow for the tests
// that expect a record, so a null fails loudly instead of as a TypeError.
const runOf = (row: ReturnType<typeof historyRow>) => {
  const { run, skipped } = historyToRun(row, SCOPE);
  if (run === null) throw new Error(`expected a run record: ${skipped}`);
  return run;
};

describe('historyToRun (assumption C)', () => {
  it('derives started_at from timestamp minus duration and validates', () => {
    const run = runOf(historyRow());
    expect(run.run.finished_at).toBe('2026-10-06T10:00:00Z');
    expect(run.run.started_at).toBe('2026-10-06T09:59:00.000Z');
    expect(run.run.status).toBe('failed');
    expect(run.results.map((r: { status: string }) => r.status)).toEqual([
      'passed',
      'failed',
    ]);
    expect(validateDocument(run, { layer: 'run' }).errors).toEqual([]);
  });

  it.each([
    ['no timestamp', { timestamp: undefined }],
    ['no duration', { duration_ms: null }],
    [
      'an unknown test status',
      { tests: [{ test_name: 'a', test_file: 'a.ts', status: 'todo' }] },
    ],
    [
      'an absolute test path',
      { tests: [{ test_name: 'a', test_file: '/abs/a.ts', status: 'passed' }] },
    ],
  ])('leaves out a row with %s, naming why', (_why, over) => {
    const out = historyToRun(historyRow(over), SCOPE);
    expect(out.run).toBeNull();
    expect(out.skipped).toMatch(/r1/);
  });

  it('carries results null, totals from the counts, for a count-only row', () => {
    const run = runOf(historyRow({ tests: undefined }));
    expect(run.results).toBeNull();
    expect(run.totals).toEqual({
      passed: 1,
      failed: 1,
      flaky: 0,
      skipped: 0,
      timed_out: 0,
      interrupted: 0,
      total: 2,
    });
    expect(validateDocument(run, { layer: 'run' }).errors).toEqual([]);
  });
});

describe('selectRuns (D15)', () => {
  const runAt = (i: number, suite = 'ts-engine') =>
    historyToRun(
      historyRow({
        run_id: `r${i}`,
        suite,
        timestamp: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
      }),
      SCOPE,
    ).run;

  it('keeps the newest 30 per suite, results only on the newest', () => {
    const all = [...Array(35).keys()]
      .map((i) => runAt(i))
      .concat(runAt(0, 'api'));
    const { feed, window } = selectRuns(all);
    const engine = feed.filter((r: any) => r.run.suite === 'ts-engine');
    expect(RUNS_PER_SUITE).toBe(30);
    expect(engine).toHaveLength(30);
    expect(engine[0].run.id).toBe('r34');
    expect(engine.filter((r: any) => r.results !== null)).toHaveLength(1);
    expect(
      feed.filter((r: any) => r.run.suite === 'api')[0].results,
    ).not.toBeNull();
    // The window keeps every kept run's results, for flaky[] (Task 12).
    expect(window.every((r: any) => r.results !== null)).toBe(true);
    for (const r of feed)
      expect(validateDocument(r, { layer: 'run' }).errors).toEqual([]);
  });

  it('windows by logical run: every shard of the newest run keeps results', () => {
    // r40 ran as two shards that finished a minute apart; the logical run's
    // time is its last shard's. 30 older runs: 29 survive beside r40.
    const sharded = [1, 2].map((s) => shardOf(runAt(40 + s), 'r40', s));
    const older = [...Array(30).keys()].map((i) => runAt(i));
    const { feed, window } = selectRuns([...older, ...sharded]);
    expect(feed).toHaveLength(31);
    const withResults = feed.filter((r: any) => r.results !== null);
    expect(withResults.map((r: any) => r.run.id).sort()).toEqual([
      'r40-s1of2',
      'r40-s2of2',
    ]);
    expect(window.map((r: any) => r.run.id)).not.toContain('r0');
    for (const r of feed)
      expect(validateDocument(r, { layer: 'run' }).errors).toEqual([]);
  });
});

/** `run` as shard `s` of 2 of the logical run `id` (the reporter's id shape). */
function shardOf(run: any, id: string, s: number) {
  return {
    ...run,
    run: { ...run.run, id: `${id}-s${s}of2`, shard: { index: s, total: 2 } },
  };
}

describe('flakyTests (D13)', () => {
  it('counts a test once, with flaky runs over runs that carry results', () => {
    const mk = (i: number, status: string) =>
      historyToRun(
        historyRow({
          run_id: `r${i}`,
          timestamp: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
          passed: status === 'passed' ? 1 : 0,
          flaky: status === 'flaky' ? 1 : 0,
          failed: 0,
          total: 1,
          tests: [{ test_name: 'a', test_file: 'test/a.test.ts', status }],
        }),
        SCOPE,
      ).run;
    const counted = historyToRun(
      historyRow({ run_id: 'c', tests: undefined }),
      SCOPE,
    ).run;
    const rows = flakyTests([
      mk(1, 'flaky'),
      mk(2, 'passed'),
      mk(3, 'flaky'),
      counted,
    ]);
    expect(rows).toEqual([
      {
        scope: SCOPE,
        suite: 'ts-engine',
        title: 'a',
        file: 'test/a.test.ts',
        flaky_runs: 2,
        window_runs: 3,
      },
    ]);
  });

  it('counts logical runs, not shard records', () => {
    const shard = (i: number, s: number, status: string) =>
      shardOf(
        historyToRun(
          historyRow({
            run_id: `r${i}`,
            timestamp: new Date(Date.UTC(2026, 9, 1, 0, i, s)).toISOString(),
            tests: [{ test_name: 'a', test_file: 'test/a.test.ts', status }],
          }),
          SCOPE,
        ).run,
        `r${i}`,
        s,
      );
    const rows = flakyTests([
      shard(1, 1, 'flaky'),
      shard(1, 2, 'passed'),
      shard(2, 1, 'flaky'),
      shard(2, 2, 'passed'),
    ]);
    expect(rows).toMatchObject([{ title: 'a', flaky_runs: 2, window_runs: 2 }]);
    // Flaking on both shards of one run (two projects) is still one run.
    const both = flakyTests([shard(1, 1, 'flaky'), shard(1, 2, 'flaky')]);
    expect(both).toMatchObject([{ flaky_runs: 1, window_runs: 1 }]);
  });
});

describe('registerRows (fork C)', () => {
  const ledgerRow = (over = {}) => ({
    test: 'adds',
    file: 'tests/cart.test.ts',
    kind: 'skipped',
    marker: 'it.skip',
    commit: 'abc1234',
    author: 'Someone',
    date: '2026-10-01T12:00:00+02:00',
    reason: 'chore: skip cart',
    cause: '',
    issue: '',
    ...over,
  });

  it('maps a ledger row, without author, empty cause/issue as null', () => {
    const { rows, skipped } = registerRows([ledgerRow()], SCOPE);
    expect(skipped).toEqual([]);
    expect(rows).toEqual([
      {
        scope: SCOPE,
        title: 'adds',
        file: 'tests/cart.test.ts',
        kind: 'skipped',
        reason: 'chore: skip cart',
        recorded_at: '2026-10-01T12:00:00+02:00',
        commit: 'abc1234',
        cause: null,
        issue: null,
      },
    ]);
  });

  it('leaves out a row with no date, commit or reason, and counts it', () => {
    const { rows, skipped } = registerRows(
      [ledgerRow({ date: '' }), ledgerRow({ commit: '' })],
      SCOPE,
    );
    expect(rows).toEqual([]);
    expect(skipped).toHaveLength(2);
  });
});

describe('ciReadyAssessments (P1, crit 8)', () => {
  const NOW = '2026-10-06T12:00:00.000Z';
  const report = (checks: object[]) => ({
    observed_at: '2026-10-06T11:00:00.000Z',
    verdict: 'incomplete',
    checked: 1,
    checks,
  });

  it('is not-assessed for every metric when no report was supplied — planted absence', () => {
    const out = ciReadyAssessments(null, SCOPE, { now: NOW, source: null });
    expect(out.map((a: any) => a.metric)).toEqual(CI_READY_METRICS);
    for (const a of out) {
      expect(a.status).toBe('not-assessed');
      expect(a.value).toBeNull();
      expect(a.reason).toMatch(/no ci-ready report/);
      expect(validateDocument(a, { layer: 'assessment' }).errors).toEqual([]);
    }
  });

  it('carries a skipped check as not-assessed with its own reason (no inventory)', () => {
    const skip = {
      name: 'coverage-depth',
      verdict: 'skip',
      reason:
        'no .canary/test-inventory.json: run `canary inventory` to produce it',
      measure: null,
    };
    const a = ciReadyAssessments(report([skip]), SCOPE, {
      now: NOW,
      source: 'ci-ready.json',
    })[0];
    expect(a).toMatchObject({
      status: 'not-assessed',
      value: null,
      reason: skip.reason,
      observed_at: '2026-10-06T11:00:00.000Z',
    });
  });

  it('maps pass/warn/fail with a measure to healthy/degraded/critical', () => {
    const m = { value: 0.2, unit: 'ratio', denominator: 5 };
    const out = ciReadyAssessments(
      report(
        ['pass', 'warn', 'fail'].map((verdict) => ({
          name: 'flakiness',
          verdict,
          reason: 'x',
          measure: m,
        })),
      ),
      SCOPE,
      { now: NOW, source: 'ci-ready.json' },
    );
    const flak = out.filter((a: any) => a.metric === 'flakiness');
    expect(flak.map((a: any) => a.status)).toEqual([
      'healthy',
      'degraded',
      'critical',
    ]);
    expect(flak[0]).toMatchObject({
      value: 0.2,
      unit: 'ratio',
      evidence: { tier: null, denominator: 5 },
      sources: ['ci-ready.json'],
    });
    for (const a of out)
      expect(validateDocument(a, { layer: 'assessment' }).errors).toEqual([]);
  });

  it('a check with a verdict but no measure is not-assessed (thin window, structural zero)', () => {
    const out = ciReadyAssessments(
      report([
        {
          name: 'flakiness',
          verdict: 'pass',
          reason: 'structural zero',
          measure: null,
        },
      ]),
      SCOPE,
      { now: NOW, source: 'r.json' },
    );
    expect(out.find((a: any) => a.metric === 'flakiness')).toMatchObject({
      status: 'not-assessed',
      reason: 'structural zero',
    });
  });

  it('names a metric the report does not carry', () => {
    const out = ciReadyAssessments(report([]), SCOPE, {
      now: NOW,
      source: 'r.json',
    });
    expect(out.find((a: any) => a.metric === 'suite-runtime')?.reason).toMatch(
      /no suite-runtime check/,
    );
  });
});

describe('latestPerKey (crit 19)', () => {
  const a = (observed_at: string, value: number, scope = SCOPE) => ({
    scope,
    source: 's',
    metric: 'm',
    observed_at,
    value,
  });
  it('keeps only the latest observed_at per scope.id + scope.env + source + metric', () => {
    const out = latestPerKey([
      a('2026-10-01T00:00:00Z', 1),
      a('2026-10-03T00:00:00Z', 3),
      a('2026-10-02T00:00:00Z', 2),
      a('2026-10-01T00:00:00Z', 9, { id: 'canary', env: 'prod' }),
    ]);
    expect(out.map((x: any) => x.value).sort()).toEqual([3, 9]);
  });
  it('compares instants, not strings, across offsets', () => {
    const out = latestPerKey([
      a('2026-10-01T10:00:00+02:00', 1),
      a('2026-10-01T09:00:00Z', 2),
    ]);
    expect(out.map((x: any) => x.value)).toEqual([2]);
  });
});

describe('loadConfig and composeFeed', () => {
  it('reads scope and declared suites; refuses a config without a full scope', () => {
    expect(parseConfig({ scope: SCOPE, suites: ['ts-engine'] })).toEqual({
      scope: SCOPE,
      suites: [{ scope: SCOPE, suite: 'ts-engine' }],
    });
    expect(parseConfig({ scope: SCOPE }).suites).toBeNull(); // D12: undeclared ≠ []
    expect(() => parseConfig({ scope: { id: 'canary' } })).toThrow(
      /scope\.env/,
    );
  });

  it('composes a valid feed whose scopes are every scope it carries', () => {
    const run = runOf(historyRow());
    const other = { ...run, scope: { id: 'web', env: 'prod' } };
    const { doc, errors } = composeFeed({
      config: parseConfig({ scope: SCOPE, suites: ['ts-engine'] }),
      runs: [run, other],
      flaky: [],
      assessments: [],
      register: [],
      now: '2026-10-06T12:00:00.000Z',
    });
    expect(errors).toEqual([]);
    expect(doc.scopes).toEqual([SCOPE, { id: 'web', env: 'prod' }]);
  });

  it('returns the validator errors for an invalid feed', () => {
    const bad = { ...runOf(historyRow()), contract: 'canary.run/9' };
    const { errors } = composeFeed({
      config: parseConfig({ scope: SCOPE }),
      runs: [bad],
      flaky: [],
      assessments: [],
      register: [],
      now: '2026-10-06T12:00:00.000Z',
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('canary-starling (end to end)', () => {
  const CI_AT = '2026-10-06T11:00:00.000Z';
  const runFile = {
    contract: 'canary.run/1',
    scope: { id: 'web', env: 'prod' },
    producer: {
      name: 'canary-test-cli/reporter',
      version: '9.0.0',
      channel: 'ci',
    },
    run: {
      id: '42-1',
      suite: 'e2e',
      branch: 'main',
      commit_sha: 'abc1234',
      started_at: '2026-10-06T09:00:00Z',
      finished_at: '2026-10-06T09:01:00Z',
      ci_url: null,
      status: 'passed',
      shard: null,
    },
    totals: {
      passed: 1,
      failed: 0,
      flaky: 0,
      skipped: 0,
      timed_out: 0,
      interrupted: 0,
      total: 1,
    },
    results: [
      {
        title: 'a',
        file: 'tests/a.spec.ts',
        status: 'passed',
        duration_ms: 5,
        retries: 0,
        area: null,
        tags: [],
        error: null,
      },
    ],
    collected: null,
  };
  const olderFlakiness = {
    contract: 'canary.assessment/1',
    scope: SCOPE,
    source: 'canary.ci-ready',
    metric: 'flakiness',
    status: 'healthy',
    value: 0,
    unit: 'ratio',
    reason: null,
    evidence: { tier: null, denominator: 10 },
    observed_at: '2026-10-01T00:00:00.000Z',
    sources: [],
    verified_by: null,
    verified_at: null,
  };
  const ciReady = {
    observed_at: CI_AT,
    verdict: 'incomplete',
    checked: 1,
    checks: [
      {
        name: 'coverage-depth',
        verdict: 'skip',
        reason:
          'no .canary/test-inventory.json: run `canary inventory` to produce it',
        measure: null,
      },
      {
        name: 'flakiness',
        verdict: 'warn',
        reason: '1 flaky',
        measure: { value: 0.05, unit: 'ratio', denominator: 20 },
      },
    ],
  };

  /** A tmp dir of inputs; `over` replaces a file's content, `null` omits it. */
  function fixture(over: Record<string, unknown> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'starling-'));
    const files: Record<string, unknown> = {
      'canary-site.config.json': { scope: SCOPE, suites: ['ts-engine'] },
      'history-v2.jsonl': [
        historyRow({ run_id: 'h1' }),
        historyRow({ run_id: 'h2', timestamp: '2026-10-06T10:30:00Z' }),
      ],
      'ci-ready.json': ciReady,
      'old-assessment.json': olderFlakiness,
      'run.json': runFile,
      ...over,
    };
    for (const [name, content] of Object.entries(files)) {
      if (content === null) continue;
      const text = name.endsWith('.jsonl')
        ? (content as object[]).map((r) => JSON.stringify(r)).join('\n') + '\n'
        : JSON.stringify(content);
      writeFileSync(join(dir, name), text, 'utf8');
    }
    return dir;
  }
  const argv = (dir: string, extra: string[] = []) => [
    '--config',
    join(dir, 'canary-site.config.json'),
    '--history',
    join(dir, 'history-v2.jsonl'),
    '--ledger',
    join(dir, 'ledger.json'),
    '--ci-ready',
    join(dir, 'ci-ready.json'),
    '--out',
    join(dir, 'site.json'),
    ...extra,
  ];
  function capture(fn: () => number) {
    const out: string[] = [];
    const err: string[] = [];
    const log = vi
      .spyOn(console, 'log')
      .mockImplementation((...a) => void out.push(a.join(' ')));
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation((...a) => void err.push(a.join(' ')));
    try {
      return { code: fn(), stdout: out.join('\n'), stderr: err.join('\n') };
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  }

  it('writes a valid feed; crit 8 planted absence and crit 19 latest-per-key hold', () => {
    const dir = fixture({
      'ledger.json': { schema_version: 1, entries: [] },
    });
    const res = capture(() =>
      starlingMain(
        argv(dir, [join(dir, 'old-assessment.json'), join(dir, 'run.json')]),
      ),
    );
    expect(res.code).toBe(0);
    const site = JSON.parse(readFileSync(join(dir, 'site.json'), 'utf8'));
    expect(validateDocument(site, { layer: 'site' }).errors).toEqual([]);
    expect(
      site.assessments.find((a: any) => a.metric === 'coverage-depth'),
    ).toMatchObject({
      status: 'not-assessed',
      reason: expect.stringMatching(/test-inventory\.json/),
    });
    const flak = site.assessments.filter((a: any) => a.metric === 'flakiness');
    expect(flak).toHaveLength(1);
    expect(flak[0]).toMatchObject({
      observed_at: CI_AT,
      status: 'degraded',
    }); // the newer ci-ready one wins
    expect(site.runs).toHaveLength(3);
    expect(site.scopes).toEqual([SCOPE, { id: 'web', env: 'prod' }]);
    expect(site.suites).toEqual([{ scope: SCOPE, suite: 'ts-engine' }]);
  });

  // composeFeed's own refusal is unit-tested in Task 16; this is the CLI's
  // earlier gate on a RECORD file that is not a valid record.
  it('refuses an invalid record file, writes nothing and exits 1, naming the file', () => {
    const dir = fixture({
      'run.json': { ...runFile, contract: 'canary.run/9' },
    });
    const res = capture(() => starlingMain(argv(dir, [join(dir, 'run.json')])));
    expect(res.code).toBe(1);
    expect(existsSync(join(dir, 'site.json'))).toBe(false);
    expect(res.stderr).toContain('run.json');
  });

  it('exits 1 on a missing config — scope is never inferred', () => {
    const dir = fixture({ 'canary-site.config.json': null });
    const res = capture(() => starlingMain(argv(dir)));
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/config/);
    expect(existsSync(join(dir, 'site.json'))).toBe(false);
  });

  it('names left-out history rows and a dark ledger on stderr', () => {
    const dir = fixture({
      'history-v2.jsonl': [
        historyRow({ run_id: 'r-nodur', duration_ms: null }),
      ],
    });
    // No --ledger: the DEFAULT path (.canary/quarantine.json, relative to the
    // cwd) is read, so run from the fixture dir, never the repo root.
    const noLedger = argv(dir).filter(
      (a, i, all) => a !== '--ledger' && all[i - 1] !== '--ledger',
    );
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const res = capture(() => starlingMain(noLedger));
      expect(res.code).toBe(0);
      expect(res.stderr).toMatch(/left out history run r-nodur/);
      expect(res.stderr).toMatch(/no quarantine ledger/);
    } finally {
      process.chdir(cwd);
    }
  });

  it('says abstained and, under --strict, exits 3 when the feed has zero runs', () => {
    const dir = fixture({
      'history-v2.jsonl': [],
      'ledger.json': { entries: [] },
    });
    const loose = capture(() => starlingMain(argv(dir)));
    expect(loose.code).toBe(0);
    expect(loose.stdout.toLowerCase()).toContain('abstained');
    expect(existsSync(join(dir, 'site.json'))).toBe(true);
    expect(capture(() => starlingMain(argv(dir, ['--strict']))).code).toBe(3);
  });
});
