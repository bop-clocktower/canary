/**
 * canary-question (#613) -- an evidence brief for one failing test. Cases are
 * tagged with the spec's success criteria (SC1-SC11,
 * docs/changes/613-canary-question/proposal.md). Fixtures are synthetic and
 * de-identified; nothing here is copied from a real store.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_HISTORY,
  buildTimeline,
  loadRuns,
  readStore,
  selectTarget,
} from '../claude-code/canary-question/scripts/history.mjs';
import {
  HYPOTHESES,
  categorizeFailure,
  categoryRows,
  coFailureRows,
  historySignals,
  isTestPath,
  resolveCategory,
  samePath,
} from '../claude-code/canary-question/scripts/signals.mjs';
import {
  diffEvidence,
  diffRows,
  readCulpritDiff,
} from '../claude-code/canary-question/scripts/diff.mjs';

const tmps: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-question-'));
  tmps.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  while (tmps.length) {
    fs.rmSync(tmps.pop()!, { recursive: true, force: true });
  }
});

type Run = Record<string, unknown>;

/** The test under question in every fixture. */
const T = 'checkout adds the item';
const TEST_FILE = 'test/cart.test.js';

function entry(status: string, over: Run = {}): Run {
  return { test_name: T, status, test_file: TEST_FILE, area: 'cart', ...over };
}

/**
 * One RunRecord (ts/src/history/record.ts) per status, oldest first. Each run
 * has its own hex commit sha and a strictly increasing timestamp; `over(i)`
 * overrides fields of run i.
 */
function series(statuses: string[], over: (i: number) => Run = () => ({})) {
  return statuses.map((status, i) => ({
    schema_version: 3,
    run_id: `r${i + 1}`,
    suite: 'unit',
    branch: 'main',
    commit_sha: `abc${i + 1}0`,
    timestamp: `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    tests: [entry(status)],
    ...over(i),
  }));
}

function writeStore(dir: string, runs: Run[]): string {
  const file = path.join(dir, 'history-v2.jsonl');
  const body = runs.map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(file, body ? `${body}\n` : '', 'utf8');
  return file;
}

const timelineOf = (runs: Run[], suite: string | null = null) =>
  buildTimeline(runs, { test: T, suite });

describe('history: reading the store (D9)', () => {
  it('refuses a missing store rather than reading it as empty', () => {
    const file = path.join(tmp(), 'absent.jsonl');
    expect(() => loadRuns(file)).toThrow(/history store not found/);
  });

  it('names the malformed line', () => {
    const file = path.join(tmp(), 'h.jsonl');
    fs.writeFileSync(file, `${JSON.stringify(series(['passed'])[0])}\n{no\n`);
    expect(() => loadRuns(file)).toThrow(/line 2/);
  });

  it('refuses a schema_version it does not understand', () => {
    const file = writeStore(tmp(), [
      { ...series(['passed'])[0], schema_version: 9 },
    ]);
    expect(() => loadRuns(file)).toThrow(/unsupported schema_version 9/);
  });

  it('refuses a non-object row and a non-array tests field', () => {
    const a = path.join(tmp(), 'a.jsonl');
    fs.writeFileSync(a, '[1]\n');
    expect(() => loadRuns(a)).toThrow(/not an object/);
    const b = writeStore(tmp(), [{ run_id: 'x', suite: 'u', tests: 'no' }]);
    expect(() => loadRuns(b)).toThrow(/tests is not an array/);
  });

  it('reads a legacy unstamped row as v2 and skips blank lines', () => {
    const file = path.join(tmp(), 'h.jsonl');
    const row = { ...series(['passed'])[0] } as Run;
    delete row.schema_version;
    fs.writeFileSync(file, `\n${JSON.stringify(row)}\n\n`);
    expect(loadRuns(file)).toHaveLength(1);
  });

  it('treats a missing DEFAULT store as a dark source, not an error', () => {
    const res = readStore(path.join(tmp(), 'absent.jsonl'), false);
    expect(res.runs).toEqual([]);
    expect(res.dark).toMatch(/no history store at/);
  });

  it('treats a missing NAMED store as an error', () => {
    const file = path.join(tmp(), 'absent.jsonl');
    expect(() => readStore(file, true)).toThrow(/history store not found/);
  });

  it('reads a present store with no dark reason', () => {
    const file = writeStore(tmp(), series(['passed']));
    expect(readStore(file, true)).toEqual({
      runs: series(['passed']),
      dark: null,
    });
  });

  it('defaults to the store the engine writes', () => {
    expect(DEFAULT_HISTORY).toBe('test-results/reports/history-v2.jsonl');
  });
});

describe('history: one test timeline', () => {
  it('orders by timestamp, not file order', () => {
    const tl = timelineOf(series(['passed', 'failed']).reverse());
    expect(tl.observations.map((o: Run) => o.status)).toEqual([
      'passed',
      'failed',
    ]);
    expect(tl.runsInStore).toBe(2);
  });

  it('ignores runs without the test and count-only runs', () => {
    const runs = [
      ...series(['passed']),
      { run_id: 'x', suite: 'unit', timestamp: '2026-09-20T00:00:00Z' },
      {
        ...series(['failed'])[0],
        tests: [{ test_name: 'other', status: 'failed' }],
      },
    ];
    const tl = timelineOf(runs);
    expect(tl.observations).toHaveLength(1);
    expect(tl.runsInStore).toBe(3);
  });

  it('counts skipped observations instead of dropping them silently', () => {
    const tl = timelineOf(series(['passed', 'skipped', 'failed']));
    expect(tl.observations).toHaveLength(2);
    expect(tl.skipped).toBe(1);
  });

  it('lists every suite the name occurs in, and narrows with a suite', () => {
    const runs = series(['passed', 'failed'], (i) =>
      i === 0 ? { suite: 'e2e' } : {},
    );
    expect(timelineOf(runs).suites).toEqual(['e2e', 'unit']);
    const narrowed = timelineOf(runs, 'unit');
    expect(narrowed.observations).toHaveLength(1);
    expect(narrowed.suites).toEqual(['unit']);
  });

  it('prefers the per-test suite over the run suite', () => {
    const runs = series(['failed'], () => ({
      tests: [entry('failed', { suite: 'api' })],
    }));
    expect(timelineOf(runs).observations[0].suite).toBe('api');
  });

  it('carries the other failing tests of the run as co-failures', () => {
    const runs = series(['failed'], () => ({
      tests: [
        entry('failed'),
        { test_name: 'b', status: 'failed', area: 'cart' },
        { test_name: 'c', status: 'passed' },
      ],
    }));
    const [obs] = timelineOf(runs).observations;
    expect(obs.coFailures.map((c: Run) => c.test_name)).toEqual(['b']);
    expect(obs.retry_count).toBe(0);
    expect(obs.test_file).toBe(TEST_FILE);
  });
});

describe('history: target failure and last pass', () => {
  it('picks the most recent failing observation and the pass before it', () => {
    const tl = timelineOf(series(['passed', 'failed', 'passed', 'flaky']));
    const { target, lastPass } = selectTarget(tl.observations);
    expect(target.run_id).toBe('r4');
    expect(lastPass.run_id).toBe('r3');
  });

  it('returns no target when nothing failed', () => {
    const tl = timelineOf(series(['passed', 'passed']));
    expect(selectTarget(tl.observations)).toEqual({
      target: null,
      lastPass: null,
    });
  });

  it('returns no last pass when the test never passed before the target', () => {
    const tl = timelineOf(series(['failed', 'failed']));
    const { target, lastPass } = selectTarget(tl.observations);
    expect(target.run_id).toBe('r2');
    expect(lastPass).toBeNull();
  });
});

function signalsFor(statuses: string[], over?: (i: number) => Run) {
  const obs = timelineOf(series(statuses, over)).observations;
  const { target } = selectTarget(obs);
  return historySignals(obs, target);
}
const bySignal = (rows: Run[], name: string) =>
  rows.find((r) => r.signal === name) as Run | undefined;

describe('signals: history (D7, D8)', () => {
  it('keeps the three hypotheses in one fixed order (D1)', () => {
    expect(HYPOTHESES).toEqual([
      'test-defect',
      'product-defect',
      'environment',
    ]);
  });

  it('SC4: a pass and a failure at one commit support all three', () => {
    const rows = signalsFor(['passed', 'failed'], () => ({
      commit_sha: 'abc1230',
    }));
    const row = bySignal(rows, 'same-commit-mixed')!;
    expect(row.supports).toEqual(HYPOTHESES);
    expect(row.weighsAgainst).toEqual([]);
    expect(row.detail).toContain('abc1230');
    expect(row.source).toBe('run history');
  });

  it('no same-commit-mixed across distinct or missing commits', () => {
    expect(
      bySignal(signalsFor(['passed', 'failed']), 'same-commit-mixed'),
    ).toBeUndefined();
    const noSha = signalsFor(['passed', 'failed'], () => ({
      commit_sha: null,
    }));
    expect(bySignal(noSha, 'same-commit-mixed')).toBeUndefined();
  });

  it('D8: a flaky target is listed under all three, not as a test defect', () => {
    const row = bySignal(signalsFor(['passed', 'flaky']), 'retry-pass')!;
    expect(row.supports).toEqual(HYPOTHESES);
    expect(row.detail).toMatch(/1 observation\(s\) with status flaky/);
  });

  it('retry-pass fires for a pass that needed a retry', () => {
    const rows = signalsFor(['passed', 'failed'], (i) =>
      i === 0 ? { tests: [entry('passed', { retry_count: 2 })] } : {},
    );
    expect(bySignal(rows, 'retry-pass')!.detail).toMatch(
      /1 pass\(es\) after a retry/,
    );
  });

  it('no retry-pass without a flaky status or a retried pass', () => {
    expect(
      bySignal(signalsFor(['passed', 'failed']), 'retry-pass'),
    ).toBeUndefined();
  });

  it('regression-shape: a pass, then >=2 failures on distinct commits', () => {
    const row = bySignal(
      signalsFor(['passed', 'failed', 'failed']),
      'regression-shape',
    )!;
    expect(row.supports).toEqual(['test-defect', 'product-defect']);
    expect(row.weighsAgainst).toEqual(['environment']);
    expect(row.detail).toContain('abc10');
  });

  it.each([
    ['one failure', ['passed', 'failed'], undefined],
    ['no prior pass', ['failed', 'failed'], undefined],
    ['a pass since', ['passed', 'failed', 'failed', 'passed'], undefined],
    [
      'one commit only',
      ['passed', 'failed', 'failed'],
      (i: number) => (i > 0 ? { commit_sha: 'abc9990' } : {}),
    ],
  ])('no regression-shape with %s', (_n, statuses, over) => {
    expect(
      bySignal(signalsFor(statuses as string[], over), 'regression-shape'),
    ).toBeUndefined();
  });
});

describe('signals: failure category (D2, D7)', () => {
  it('categorises exactly like canary-fail-fast', () => {
    expect(categorizeFailure('connect ECONNREFUSED 127.0.0.1')).toBe('network');
    expect(categorizeFailure('Timed out after 5000ms')).toBe('timeout');
    expect(categorizeFailure('503 Service Unavailable')).toBe('server');
    expect(categorizeFailure('ZodError: invalid_type')).toBe('schema');
    expect(categorizeFailure('401 Unauthorized')).toBe('auth');
    expect(categorizeFailure('404 not found')).toBe('client');
    expect(categorizeFailure('expected 2 to equal 3')).toBe('other');
    expect(categorizeFailure(null)).toBe('other');
  });

  it('prefers the stored category and names where it came from', () => {
    expect(
      resolveCategory({ failure_category: 'server', error_text: 'timeout' }),
    ).toEqual({ category: 'server', source: 'stored failure_category' });
    expect(
      resolveCategory({ failure_category: null, error_text: 'ETIMEDOUT' }),
    ).toEqual({ category: 'timeout', source: 'categorised from error_text' });
    expect(
      resolveCategory({ failure_category: null, error_text: null }),
    ).toBeNull();
  });

  it.each(['timeout', 'network', 'auth'])('%s is environment evidence', (c) => {
    const [r] = categoryRows({ failure_category: c });
    expect(r.signal).toBe('category-env');
    expect(r.supports).toEqual(['environment']);
  });

  it('server (5xx) is product-defect evidence', () => {
    const [r] = categoryRows({ failure_category: 'server' });
    expect(r.signal).toBe('category-server');
    expect(r.supports).toEqual(['product-defect']);
  });

  it('any other category is recorded as not discriminating', () => {
    const [r] = categoryRows({ failure_category: 'client' });
    expect(r.signal).toBe('category-neutral');
    expect(r.supports).toEqual([]);
    expect(r.weighsAgainst).toEqual([]);
  });

  it('no category row when there is nothing to categorise', () => {
    expect(categoryRows({ failure_category: null, error_text: null })).toEqual(
      [],
    );
  });
});

describe('signals: co-failures in the target run', () => {
  const target = (coFailures: Run[], over: Run = {}) => ({
    run_id: 'r9',
    area: 'cart',
    failure_category: 'timeout',
    error_text: null,
    coFailures,
    ...over,
  });

  it('isolated: the only failure supports test-defect, weighs against env', () => {
    const [r] = coFailureRows(target([]));
    expect(r.signal).toBe('isolated');
    expect(r.supports).toEqual(['test-defect']);
    expect(r.weighsAgainst).toEqual(['environment']);
  });

  it('co-failure when another failure shares the area', () => {
    const [r] = coFailureRows(
      target([{ test_name: 'b', area: 'cart', failure_category: 'schema' }]),
    );
    expect(r.signal).toBe('co-failure');
    expect(r.supports).toEqual(['product-defect', 'environment']);
    expect(r.weighsAgainst).toEqual(['test-defect']);
    expect(r.detail).toContain('b');
  });

  it('co-failure when another failure shares the category', () => {
    const rows = coFailureRows(
      target([{ test_name: 'c', area: 'billing', error_text: 'ETIMEDOUT' }]),
    );
    expect(rows[0].signal).toBe('co-failure');
  });

  it('an uncategorised pair is not a shared cause', () => {
    const rows = coFailureRows(
      target([{ test_name: 'd', area: null, failure_category: 'other' }], {
        area: null,
        failure_category: 'other',
      }),
    );
    expect(rows).toEqual([]);
  });

  it('no row when other failures share neither area nor category', () => {
    const rows = coFailureRows(
      target([{ test_name: 'e', area: 'billing', failure_category: 'schema' }]),
    );
    expect(rows).toEqual([]);
  });
});

describe('signals: test paths', () => {
  it.each([
    ['src/cart.test.ts', true],
    ['web/cart.spec.js', true],
    ['pkg/test_cart.py', true],
    ['pkg/cart_test.py', true],
    ['svc/cart_test.go', true],
    ['test/helpers.js', true],
    ['a/tests/fixture.json', true],
    ['a/__tests__/x.js', true],
    ['src/cart.ts', false],
    ['src/testing/cart.ts', false],
  ])('isTestPath(%s) is %s', (p, want) => {
    expect(isTestPath(p)).toBe(want);
  });

  it('matches paths on a segment boundary, ignoring ./ and backslashes', () => {
    expect(samePath('./test/a.test.js', 'repo/test/a.test.js')).toBe(true);
    expect(samePath('test\\a.test.js', 'test/a.test.js')).toBe(true);
    expect(samePath('test/a.test.js', 'test/ba.test.js')).toBe(false);
  });
});

/** Run git in `repo` with an identity and no signing, whatever the host has. */
function git(repo: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-C',
      repo,
      '-c',
      'user.email=question@example.invalid',
      '-c',
      'user.name=question',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { encoding: 'utf8' },
  ).trim();
}

function touch(repo: string, file: string): void {
  const full = path.join(repo, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.appendFileSync(full, `// ${Math.random()}\n`);
}

/** A repo with a SUT file and a test file; returns the base sha. */
function repoWithBase(): { repo: string; base: string } {
  const repo = tmp();
  git(repo, 'init', '-q');
  touch(repo, 'src/cart.js');
  touch(repo, TEST_FILE);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  return { repo, base: git(repo, 'rev-parse', 'HEAD') };
}

function commitTouching(repo: string, files: string[]): string {
  for (const f of files) touch(repo, f);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'change');
  return git(repo, 'rev-parse', 'HEAD');
}

describe('diff: reading the culprit range', () => {
  it('lists the files changed between two commits', () => {
    const { repo, base } = repoWithBase();
    const head = commitTouching(repo, [TEST_FILE]);
    expect(readCulpritDiff(repo, base, head)).toEqual({
      files: [TEST_FILE],
      error: null,
    });
  });

  it('reports, never throws, when a commit is unreachable', () => {
    const { repo, base } = repoWithBase();
    const res = readCulpritDiff(repo, base, 'deadbeefdeadbeef');
    expect(res.files).toBeNull();
    expect(res.error).toBeTruthy();
  });

  it('reports, never throws, outside a git repository', () => {
    const res = readCulpritDiff(tmp(), 'abc1', 'abc2');
    expect(res.files).toBeNull();
    expect(res.error).toBeTruthy();
  });
});

describe('diff: classifying the range (SC5)', () => {
  it('diff-test-only is for test-defect and against product-defect', () => {
    const [r] = diffRows([TEST_FILE], TEST_FILE);
    expect(r.signal).toBe('diff-test-only');
    expect(r.supports).toEqual(['test-defect']);
    expect(r.weighsAgainst).toEqual(['product-defect']);
    expect(r.detail).toContain(`test file ${TEST_FILE} changed`);
  });

  it('diff-sut-only is the mirror image', () => {
    const [r] = diffRows(['src/cart.js'], TEST_FILE);
    expect(r.signal).toBe('diff-sut-only');
    expect(r.supports).toEqual(['product-defect']);
    expect(r.weighsAgainst).toEqual(['test-defect']);
    expect(r.detail).toContain(`test file ${TEST_FILE} unchanged`);
  });

  it('diff-both supports both code hypotheses', () => {
    const [r] = diffRows(['src/cart.js', TEST_FILE], TEST_FILE);
    expect(r.signal).toBe('diff-both');
    expect(r.supports).toEqual(['test-defect', 'product-defect']);
  });

  it('diff-none (same tree) supports environment', () => {
    const [r] = diffRows([], TEST_FILE);
    expect(r.signal).toBe('diff-none');
    expect(r.supports).toEqual(['environment']);
  });

  it('says so when test_file was not recorded', () => {
    const [r] = diffRows(['tests/x.py'], null);
    expect(r.signal).toBe('diff-test-only');
    expect(r.detail).toMatch(/test_file not recorded/);
  });
});

describe('diff: evidence or Not checked (SC6)', () => {
  const obs = (sha: string | null, testFile: string | null = TEST_FILE) => ({
    commit_sha: sha,
    test_file: testFile,
  });

  it('no culprit range without a prior pass', () => {
    const res = diffEvidence({
      repo: '.',
      target: obs('abc1'),
      lastPass: null,
    });
    expect(res.read).toBe(false);
    expect(res.notChecked[0].source).toBe('git diff');
    expect(res.notChecked[0].reason).toMatch(/no passing observation/);
  });

  it('refuses a sha that is not a hex object id (never reaches git)', () => {
    const res = diffEvidence({
      repo: '.',
      target: obs('--output=/tmp/x'),
      lastPass: obs('abc1'),
    });
    expect(res.read).toBe(false);
    expect(res.notChecked[0].reason).toMatch(/not a hex object id/);
  });

  it('names the git error when the range cannot be read', () => {
    const res = diffEvidence({
      repo: tmp(),
      target: obs('abc2'),
      lastPass: obs('abc1'),
    });
    expect(res.read).toBe(false);
    expect(res.notChecked[0].reason).toMatch(/git could not diff abc1\.\.abc2/);
  });

  it('reads the range and classifies it', () => {
    const { repo, base } = repoWithBase();
    const head = commitTouching(repo, ['src/cart.js']);
    const res = diffEvidence({
      repo,
      target: obs(head),
      lastPass: obs(base),
    });
    expect(res.read).toBe(true);
    expect(res.notChecked).toEqual([]);
    expect(res.rows[0].signal).toBe('diff-sut-only');
  });
});
