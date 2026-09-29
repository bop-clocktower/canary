/**
 * canary-question (#613) -- an evidence brief for one failing test. Cases are
 * tagged with the spec's success criteria (SC1-SC11,
 * docs/changes/613-canary-question/proposal.md). Fixtures are synthetic and
 * de-identified; nothing here is copied from a real store.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
import {
  findingsEvidence,
  loadFindings,
} from '../claude-code/canary-question/scripts/findings.mjs';
import {
  BANNER,
  THIN_OBSERVATIONS,
  abstentionFor,
  assembleBrief,
  renderJson,
  renderMarkdown,
} from '../claude-code/canary-question/scripts/brief.mjs';
import { CLI_SPEC, main } from '../claude-code/canary-question/scripts/cli.mjs';

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
    expect(obs.testsInRun).toBe(3);
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
    // A persistent environment change makes the same shape.
    expect(row.weighsAgainst).toEqual([]);
    expect(row.detail).toContain('abc10');
  });

  it.each([
    ['one failure', ['passed', 'failed'], undefined],
    ['no prior pass', ['failed', 'failed'], undefined],
    ['a pass since', ['passed', 'failed', 'failed', 'passed'], undefined],
    // A flaky observation passed on retry: the streak is not all failures.
    ['a flaky in the streak', ['passed', 'flaky', 'failed'], undefined],
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

  it.each([
    // A slow or misconfigured system under test times out and 401s too.
    ['timeout', ['environment', 'product-defect']],
    ['auth', ['environment', 'product-defect']],
    ['network', ['environment']],
  ])('%s is evidence for %j', (c, want) => {
    const [r] = categoryRows({ failure_category: c });
    expect(r.signal).toBe('category-env');
    expect(r.supports).toEqual(want);
    expect(r.weighsAgainst).toEqual([]);
  });

  it('server (5xx) is product or environment evidence (502/503 are infrastructure)', () => {
    const [r] = categoryRows({ failure_category: 'server' });
    expect(r.signal).toBe('category-server');
    expect(r.supports).toEqual(['product-defect', 'environment']);
    expect(r.weighsAgainst).toEqual([]);
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
    testsInRun: 5,
    ...over,
  });

  it('isolated: failing alone supports both code hypotheses, not the test alone', () => {
    const [r] = coFailureRows(target([]));
    expect(r.signal).toBe('isolated');
    // A narrow product regression also fails alone.
    expect(r.supports).toEqual(['test-defect', 'product-defect']);
    expect(r.weighsAgainst).toEqual(['environment']);
    expect(r.detail).toContain('5 tests in run');
  });

  it('a run of one test cannot show isolation: a neutral row, not isolated', () => {
    const rows = coFailureRows(target([], { testsInRun: 1 }));
    expect(rows).toHaveLength(1);
    expect(rows[0].signal).not.toBe('isolated');
    expect(rows[0].supports).toEqual([]);
    expect(rows[0].weighsAgainst).toEqual([]);
    expect(rows[0].detail).toMatch(/run r9 contained only this test/);
  });

  it('an unrecorded run size cannot show isolation either', () => {
    const rows = coFailureRows(target([], { testsInRun: undefined }));
    expect(rows.map((r) => r.signal)).not.toContain('isolated');
    expect(rows[0].supports).toEqual([]);
  });

  it('co-failure when another failure shares the area', () => {
    const [r] = coFailureRows(
      target([{ test_name: 'b', area: 'cart', failure_category: 'schema' }]),
    );
    expect(r.signal).toBe('co-failure');
    expect(r.supports).toEqual(['product-defect', 'environment']);
    expect(r.weighsAgainst).toEqual([]);
    expect(r.detail).toContain('b');
    expect(r.detail).toMatch(
      /shared test helper or fixture fails the same way/,
    );
  });

  it('co-failure when another failure shares the category', () => {
    const rows = coFailureRows(
      target([{ test_name: 'c', area: 'billing', error_text: 'ETIMEDOUT' }]),
    );
    expect(rows[0].signal).toBe('co-failure');
  });

  const unrelatedRow = {
    signal: 'unrelated-co-failures',
    source: 'run history',
    detail: '1 other failure(s) in run r9, none sharing area or category',
    supports: [],
    weighsAgainst: [],
  };

  it('an uncategorised pair is not a shared cause', () => {
    const rows = coFailureRows(
      target([{ test_name: 'd', area: null, failure_category: 'other' }], {
        area: null,
        failure_category: 'other',
      }),
    );
    expect(rows).toEqual([unrelatedRow]);
  });

  it('unrelated failures in the run are recorded as not discriminating', () => {
    const rows = coFailureRows(
      target([{ test_name: 'e', area: 'billing', failure_category: 'schema' }]),
    );
    expect(rows).toEqual([unrelatedRow]);
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
  it('diff-test-only is for test-defect and against nothing', () => {
    const [r] = diffRows([TEST_FILE], TEST_FILE);
    expect(r.signal).toBe('diff-test-only');
    expect(r.supports).toEqual(['test-defect']);
    expect(r.weighsAgainst).toEqual([]);
    expect(r.detail).toContain(`test file ${TEST_FILE} changed`);
    expect(r.detail).toContain(
      'a changed test may also be exposing an existing product defect',
    );
  });

  it('diff-sut-only is the mirror image', () => {
    const [r] = diffRows(['src/cart.js'], TEST_FILE);
    expect(r.signal).toBe('diff-sut-only');
    expect(r.supports).toEqual(['product-defect']);
    expect(r.weighsAgainst).toEqual([]);
    expect(r.detail).toContain(`test file ${TEST_FILE} unchanged`);
    expect(r.detail).toContain(
      "an intentional product change can leave the test's expectation stale",
    );
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

  it('a pass and a failure at one commit have no culprit range', () => {
    const res = diffEvidence({
      repo: '.',
      target: obs('abc1230'),
      lastPass: obs('abc1230'),
    });
    expect(res.read).toBe(false);
    expect(res.notChecked).toEqual([
      {
        source: 'git diff',
        reason: 'pass and failure at the same commit; no culprit range',
      },
    ]);
    const brief = briefFor(
      series(['passed', 'passed', 'failed'], () => ({ commit_sha: 'abc1230' })),
      { diff: res },
    );
    expect(brief.fidelity).toBe('history');
  });

  it('a last pass on another branch is not a culprit range', () => {
    const { repo, base } = repoWithBase();
    git(repo, 'checkout', '-qb', 'side');
    const side = commitTouching(repo, ['src/cart.js']);
    git(repo, 'checkout', '-q', base);
    const other = commitTouching(repo, [TEST_FILE]);
    const res = diffEvidence({
      repo,
      target: obs(other),
      lastPass: obs(side),
    });
    expect(res.read).toBe(false);
    expect(res.notChecked).toEqual([
      {
        source: 'git diff',
        reason:
          'last pass is not an ancestor of the target; the range spans branches',
      },
    ]);
  });

  it('reads a changed-file list larger than the default 1 MiB buffer', () => {
    // A stand-in `git` on PATH: merge-base succeeds, diff prints ~2 MB.
    const bin = tmp();
    const fake = path.join(bin, 'git');
    fs.writeFileSync(
      fake,
      '#!/bin/sh\n' +
        'case "$3" in\n' +
        '  merge-base) exit 0 ;;\n' +
        '  diff) awk \'BEGIN { for (i = 0; i < 20000; i++) printf "src/%096d.js\\n", i }\' ;;\n' +
        'esac\n',
    );
    fs.chmodSync(fake, 0o755);
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`);
    try {
      const res = diffEvidence({
        repo: '.',
        target: obs('abc2'),
        lastPass: obs('abc1'),
      });
      expect(res.notChecked).toEqual([]);
      expect(res.read).toBe(true);
      expect(res.rows[0].detail).toMatch(/^0 test path\(s\), 20000 non-test/);
    } finally {
      vi.unstubAllEnvs();
    }
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

/** A Tier-0 detector `--json` envelope (canary-savant/SKILL.md shape). */
function writeFindings(dir: string, findings: unknown): string {
  const file = path.join(dir, 'findings.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ schema_version: 1, findings, summary: {} }),
    'utf8',
  );
  return file;
}

describe('findings: reading the envelope (D9)', () => {
  it('refuses a named file that does not exist', () => {
    expect(() => loadFindings(path.join(tmp(), 'nope.json'))).toThrow(
      /findings file not found/,
    );
  });

  it('refuses malformed JSON and an envelope with no findings array', () => {
    const a = path.join(tmp(), 'a.json');
    fs.writeFileSync(a, '{no');
    expect(() => loadFindings(a)).toThrow(/malformed findings file/);
    const b = path.join(tmp(), 'b.json');
    fs.writeFileSync(b, '{"schema_version":1}');
    expect(() => loadFindings(b)).toThrow(/no findings array/);
  });

  it('reads the findings, ignoring non-object entries', () => {
    const file = writeFindings(tmp(), [{ file: 'x', line: 1 }, 7, null]);
    expect(loadFindings(file)).toEqual([{ file: 'x', line: 1 }]);
  });
});

describe('findings: evidence on the test file (SC7)', () => {
  const findings = [
    { file: `./${TEST_FILE}`, line: 3, rule_id: 'SV001-module-mutable-global' },
    { file: 'test/other.test.js', line: 9, rule_id: 'BH001-wall-clock' },
    { file: TEST_FILE, kind: 'last-coverage-removed' },
    { line: 4, rule_id: 'no-file' },
  ];

  it('quotes rule id and line for findings on the test file only', () => {
    const res = findingsEvidence(findings, TEST_FILE);
    expect(res.notChecked).toEqual([]);
    expect(res.rows.map((r: Run) => r.detail)).toEqual([
      `SV001-module-mutable-global at ./${TEST_FILE}:3`,
      `last-coverage-removed at ${TEST_FILE}`,
    ]);
    expect(res.rows[0].signal).toBe('detector-finding');
    expect(res.rows[0].supports).toEqual(['test-defect']);
    expect(res.rows[0].weighsAgainst).toEqual([]);
  });

  it('falls back to "unnamed rule" when a finding names none', () => {
    const res = findingsEvidence([{ file: TEST_FILE, line: 1 }], TEST_FILE);
    expect(res.rows[0].detail).toBe(`unnamed rule at ${TEST_FILE}:1`);
  });

  it('lists findings as Not checked when no file was given', () => {
    const res = findingsEvidence(null, TEST_FILE);
    expect(res.rows).toEqual([]);
    expect(res.notChecked).toEqual([
      { source: 'detector findings', reason: 'no --findings file given' },
    ]);
  });

  it('lists findings as Not checked when the test file is unknown', () => {
    const res = findingsEvidence(findings, null);
    expect(res.rows).toEqual([]);
    expect(res.notChecked[0].reason).toMatch(/no test_file/);
  });
});

const NOT_READ = {
  read: false,
  rows: [],
  notChecked: [{ source: 'git diff', reason: 'not exercised in this case' }],
};

/** Build the pure assembleBrief input the CLI would, from runs. */
function inputFor(
  runs: Run[],
  opts: {
    suite?: string | null;
    diff?: unknown;
    findings?: Run[] | null;
    historyDark?: string | null;
  } = {},
) {
  const suite = opts.suite ?? null;
  const timeline = timelineOf(runs, suite);
  const { target, lastPass } = selectTarget(timeline.observations);
  const abstained = abstentionFor(timeline, target, suite);
  return {
    test: T,
    suite,
    historyDark: opts.historyDark ?? null,
    timeline,
    target,
    lastPass,
    abstained,
    diff: abstained ? null : (opts.diff ?? NOT_READ),
    findings: opts.findings ?? null,
  };
}
const briefFor = (runs: Run[], opts?: Parameters<typeof inputFor>[1]) =>
  assembleBrief(inputFor(runs, opts));
const forOf = (brief: Run, id: string) =>
  (brief.hypotheses as Run[]).find((h) => h.id === id)!.for as Run[];
const againstOf = (brief: Run, id: string) =>
  (brief.hypotheses as Run[]).find((h) => h.id === id)!.against as Run[];
const signals = (rows: Run[]) => rows.map((r) => r.signal);

describe('brief: abstention is loud (D5, D6)', () => {
  it('SC1: no observation of the test abstains with observations: 0', () => {
    const brief = briefFor(series(['passed'], () => ({ tests: [] })));
    expect(brief.fidelity).toBe('abstained');
    expect(brief.denominator).toEqual({
      observations: 0,
      failures: 0,
      runs_in_store: 1,
    });
    expect(brief.abstained.reason).toMatch(/no observation of this test in 1/);
    expect(brief.hypotheses.map((h: Run) => [h.for, h.against])).toEqual([
      [[], []],
      [[], []],
      [[], []],
    ]);
    expect(brief.target).toEqual({});
    expect(brief.disambiguate).toHaveLength(1);
  });

  it('SC2: observations but no failure abstains with the count', () => {
    const brief = briefFor(series(['passed', 'passed', 'passed']));
    expect(brief.fidelity).toBe('abstained');
    expect(brief.abstained.reason).toBe(
      'no failing observation in 3 observation(s)',
    );
    expect(brief.denominator.observations).toBe(3);
  });

  it('a name in several suites abstains and lists them until --suite', () => {
    const runs = series(['failed', 'failed'], (i) =>
      i === 0 ? { suite: 'e2e' } : {},
    );
    const brief = briefFor(runs);
    expect(brief.abstained.suites).toEqual(['e2e', 'unit']);
    expect(brief.disambiguate[0]).toContain('--suite');
    expect(briefFor(runs, { suite: 'unit' }).abstained).toBeNull();
  });

  it('an abstained brief never claims every source was read', () => {
    const brief = briefFor(series(['passed', 'passed']), {
      findings: [{ file: TEST_FILE, line: 1, rule_id: 'SV001' }],
    });
    expect(brief.not_checked).toEqual([
      { source: 'git diff', reason: 'not read: brief abstained' },
      { source: 'detector findings', reason: 'not read: brief abstained' },
    ]);
    const md = renderMarkdown(brief);
    expect(md).not.toContain('every source was read');
    expect(md).toContain('- git diff: not read: brief abstained');
  });

  it('an abstained brief without --findings still names the unread diff', () => {
    const brief = briefFor(series(['passed', 'passed']));
    expect(brief.not_checked).toEqual([
      { source: 'git diff', reason: 'not read: brief abstained' },
    ]);
    const emptied = { ...brief, not_checked: [] };
    expect(renderMarkdown(emptied)).not.toContain('every source was read');
  });

  it('names a dark default store under Not checked', () => {
    const brief = briefFor([], { historyDark: 'no history store at x' });
    expect(brief.not_checked).toContainEqual({
      source: 'run history',
      reason: 'no history store at x',
    });
  });
});

describe('brief: fidelity is derived, never asserted (D5)', () => {
  it('SC3: fewer than 3 observations is thin', () => {
    expect(THIN_OBSERVATIONS).toBe(3);
    const brief = briefFor(series(['passed', 'failed']));
    expect(brief.fidelity).toBe('thin');
    expect(brief.disambiguate.join('\n')).toMatch(/Record more runs/);
  });

  it('3+ observations without a diff is history', () => {
    expect(briefFor(series(['passed', 'passed', 'failed'])).fidelity).toBe(
      'history',
    );
  });

  it('SC6: an unread diff is Not checked and fidelity stays history', () => {
    const brief = briefFor(series(['passed', 'passed', 'failed']));
    expect(brief.fidelity).toBe('history');
    expect(brief.not_checked.map((n: Run) => n.source)).toContain('git diff');
  });

  it('SC5: a read diff is history+diff and places test-only evidence', () => {
    const diff = {
      read: true,
      rows: diffRows([TEST_FILE], TEST_FILE),
      notChecked: [],
    };
    const brief = briefFor(series(['passed', 'passed', 'failed']), { diff });
    expect(brief.fidelity).toBe('history+diff');
    expect(signals(forOf(brief, 'test-defect'))).toContain('diff-test-only');
    // Amended after review: a changed test can expose an existing product
    // defect, so a test-only range is not evidence against the product.
    expect(signals(againstOf(brief, 'product-defect'))).not.toContain(
      'diff-test-only',
    );
  });

  it('SC5: sut-only is symmetric', () => {
    const diff = {
      read: true,
      rows: diffRows(['src/cart.js'], TEST_FILE),
      notChecked: [],
    };
    const brief = briefFor(series(['passed', 'passed', 'failed']), { diff });
    expect(signals(forOf(brief, 'product-defect'))).toContain('diff-sut-only');
    expect(signals(againstOf(brief, 'test-defect'))).not.toContain(
      'diff-sut-only',
    );
  });

  it('a read diff on a thin timeline stays thin', () => {
    const diff = { read: true, rows: diffRows([], TEST_FILE), notChecked: [] };
    expect(briefFor(series(['passed', 'failed']), { diff }).fidelity).toBe(
      'thin',
    );
  });
});

describe('brief: evidence placement', () => {
  it('SC4: same-commit-mixed appears under all three hypotheses', () => {
    const brief = briefFor(
      series(['passed', 'failed'], () => ({ commit_sha: 'abc1230' })),
    );
    for (const id of HYPOTHESES) {
      expect(signals(forOf(brief, id))).toContain('same-commit-mixed');
    }
  });

  it('SC7: a finding on the test file is test-defect evidence', () => {
    const brief = briefFor(series(['passed', 'failed']), {
      findings: [
        { file: TEST_FILE, line: 3, rule_id: 'SV001-module-mutable-global' },
        { file: 'test/other.test.js', line: 1, rule_id: 'BH001-wall-clock' },
      ],
    });
    const rows = forOf(brief, 'test-defect').filter(
      (r) => r.signal === 'detector-finding',
    );
    expect(rows.map((r) => r.detail)).toEqual([
      `SV001-module-mutable-global at ${TEST_FILE}:3`,
    ]);
  });

  it('a non-discriminating category lands in neutral, not a hypothesis', () => {
    const brief = briefFor(
      series(['passed', 'failed'], () => ({
        tests: [entry('failed', { failure_category: 'client' })],
      })),
    );
    // One test per run in this fixture, so isolation is not observable either.
    expect(signals(brief.neutral)).toEqual([
      'category-neutral',
      'single-test-run',
    ]);
    for (const h of brief.hypotheses) {
      expect(signals([...h.for, ...h.against])).not.toContain(
        'category-neutral',
      );
    }
  });

  it('rows carry signal, source and detail only', () => {
    const brief = briefFor(series(['passed', 'failed', 'failed']));
    expect(Object.keys(forOf(brief, 'test-defect')[0]).sort()).toEqual([
      'detail',
      'signal',
      'source',
    ]);
  });

  it('names a missing category, skipped observations and unread findings', () => {
    const brief = briefFor(series(['skipped', 'passed', 'failed']));
    const sources = brief.not_checked.map((n: Run) => n.source);
    expect(sources).toEqual([
      'skipped observations',
      'failure category',
      'git diff',
      'detector findings',
    ]);
  });

  it('records the target and the last pass', () => {
    const brief = briefFor(series(['passed', 'failed']));
    expect(brief.target).toMatchObject({
      run_id: 'r2',
      commit_sha: 'abc20',
      status: 'failed',
      last_pass_commit_sha: 'abc10',
    });
    expect(brief.schema_version).toBe(1);
    expect(brief.advisory).toBe(true);
    expect(brief.suite).toBe('unit');
  });
});

describe('brief: fixed order (SC8, D1)', () => {
  it('orders hypotheses identically whichever side the evidence favours', () => {
    const favourTest = briefFor(series(['passed', 'passed', 'failed']), {
      diff: {
        read: true,
        rows: diffRows([TEST_FILE], TEST_FILE),
        notChecked: [],
      },
    });
    const favourProduct = briefFor(
      series(['passed', 'passed', 'failed'], () => ({
        tests: [entry('failed', { failure_category: 'server' })],
      })),
      {
        diff: {
          read: true,
          rows: diffRows(['src/cart.js'], TEST_FILE),
          notChecked: [],
        },
      },
    );
    const favourEnv = briefFor(
      series(['passed', 'passed', 'failed'], () => ({
        tests: [
          entry('failed', { error_text: 'connect ECONNREFUSED' }),
          { test_name: 'b', status: 'failed', area: 'cart' },
        ],
      })),
    );
    for (const brief of [favourTest, favourProduct, favourEnv]) {
      expect(brief.hypotheses.map((h: Run) => h.id)).toEqual(HYPOTHESES);
    }
  });
});

describe('brief: disambiguation is always offered', () => {
  it('names the commits that would isolate a test or product change', () => {
    const steps = briefFor(series(['passed', 'passed', 'failed'])).disambiguate;
    expect(steps[0]).toMatch(/^Re-run .* several times at abc30/);
    expect(steps.join('\n')).toMatch(/canary-savant --confirm on test\/cart/);
    expect(steps.join('\n')).toMatch(/Check out abc20/);
    expect(steps.join('\n')).toMatch(/system under test at abc20/);
  });

  it('omits the range steps when there is no prior pass', () => {
    const steps = briefFor(series(['failed', 'failed', 'failed'])).disambiguate;
    expect(steps.join('\n')).not.toMatch(/Check out/);
    expect(steps.length).toBeGreaterThanOrEqual(1);
  });
});

type Brief = ReturnType<typeof assembleBrief>;

/** Every fixture the guard runs over: one per shape the brief can take. */
const SCENARIOS: Record<string, () => Brief> = {
  'no observation': () => briefFor([]),
  'no failure': () => briefFor(series(['passed', 'passed', 'passed'])),
  'ambiguous suite': () =>
    briefFor(
      series(['failed', 'failed'], (i) => (i === 0 ? { suite: 'e2e' } : {})),
    ),
  'dark default store': () =>
    briefFor([], { historyDark: 'no history store at x' }),
  thin: () => briefFor(series(['passed', 'failed'])),
  'same commit mixed': () =>
    briefFor(series(['passed', 'flaky'], () => ({ commit_sha: 'abc1230' }))),
  'regression, test-only diff': () =>
    briefFor(series(['passed', 'failed', 'failed']), {
      diff: {
        read: true,
        rows: diffRows([TEST_FILE], TEST_FILE),
        notChecked: [],
      },
    }),
  'server error, sut-only diff': () =>
    briefFor(
      series(['passed', 'passed', 'failed'], () => ({
        tests: [entry('failed', { failure_category: 'server' })],
      })),
      {
        diff: {
          read: true,
          rows: diffRows(['src/cart.js'], TEST_FILE),
          notChecked: [],
        },
      },
    ),
  'environment, co-failures, no diff': () =>
    briefFor(
      series(['passed', 'passed', 'failed'], () => ({
        tests: [
          entry('failed', { error_text: 'connect ECONNREFUSED' }),
          { test_name: 'b', status: 'failed', area: 'cart' },
        ],
      })),
      { diff: { read: true, rows: diffRows([], null), notChecked: [] } },
    ),
  'neutral category, findings': () =>
    briefFor(
      series(['passed', 'passed', 'failed'], () => ({
        tests: [
          entry('failed', { failure_category: 'client', test_file: null }),
        ],
      })),
      { findings: [{ file: TEST_FILE, line: 1, rule_id: 'SV001' }] },
    ),
  'finding on the test file': () =>
    briefFor(series(['skipped', 'passed', 'failed']), {
      findings: [{ file: TEST_FILE, line: 2, rule_id: 'BH001-wall-clock' }],
    }),
};

const FORBIDDEN_PHRASES = [
  'verdict',
  'root cause',
  'is flaky',
  'test bug',
  'product bug',
  'likely',
  'probably',
  'most likely',
];
const FORBIDDEN_KEYS = ['verdict', 'disposition', 'score'];

/** Phrases present in `text` once the one sanctioned disclaimer is removed. */
function forbiddenIn(text: string): string[] {
  const scanned = text.toLowerCase();
  return FORBIDDEN_PHRASES.filter((p) => scanned.includes(p));
}

function keysOf(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      keysOf(v, out);
    }
  }
  return out;
}

describe('render: markdown', () => {
  it('prints the banner, fidelity, denominator and every section in order', () => {
    const md = renderMarkdown(briefFor(series(['passed', 'passed', 'failed'])));
    expect(md).toContain(`# canary-question: ${T}`);
    expect(md).toContain(BANNER);
    expect(md).toContain('**Fidelity:** history');
    expect(md).toContain('observations: 3 · failures: 1 · runs in store: 3');
    const order = [
      '## Defect in the test',
      '## Defect in the system under test',
      '## Environment or infrastructure',
      '## Not checked',
      '## What would disambiguate',
    ].map((h) => md.indexOf(h));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('SC1: an abstained brief says ABSTAINED and shows no hypothesis evidence', () => {
    const md = renderMarkdown(briefFor([]));
    expect(md).toContain('ABSTAINED');
    expect(md).toContain('observations: 0');
    expect(md).not.toContain('## Defect in the test');
    expect(md).toContain('## What would disambiguate');
  });

  it('SC3: a thin brief carries a THIN EVIDENCE banner', () => {
    expect(renderMarkdown(briefFor(series(['passed', 'failed'])))).toMatch(
      /THIN EVIDENCE.*2 of 3 observations/,
    );
  });

  it('says "none recorded" for an empty side, and renders neutral rows', () => {
    const md = renderMarkdown(SCENARIOS['neutral category, findings']());
    expect(md).toContain('- none recorded');
    expect(md).toContain('## Recorded, does not discriminate');
    expect(md).toContain('`category-neutral`');
  });

  it('says so when every source was read', () => {
    const brief = SCENARIOS['regression, test-only diff']();
    brief.not_checked = [];
    expect(renderMarkdown(brief)).toContain('- nothing; every source was read');
  });
});

describe('render: json', () => {
  it('round-trips the brief object', () => {
    const brief = briefFor(series(['passed', 'failed']));
    expect(JSON.parse(renderJson(brief))).toEqual(brief);
  });
});

describe('no verdict language, ever (SC9, D11)', () => {
  it('the guard catches a planted phrase (so it is not vacuous)', () => {
    expect(forbiddenIn('this probably breaks')).toEqual(['probably']);
    expect(forbiddenIn(BANNER)).toEqual([]);
    expect(keysOf({ a: [{ score: 1 }] })).toContain('score');
  });

  for (const [name, build] of Object.entries(SCENARIOS)) {
    it(`${name}: markdown and JSON are clean`, () => {
      const brief = build();
      expect(forbiddenIn(renderMarkdown(brief))).toEqual([]);
      expect(forbiddenIn(renderJson(brief))).toEqual([]);
      const keys = keysOf(brief);
      expect(keys.filter((k) => FORBIDDEN_KEYS.includes(k))).toEqual([]);
      expect(brief.hypotheses.map((h: Run) => h.id)).toEqual(HYPOTHESES);
    });
  }

  it('covers at least 10 fixtures (a shrunken list would pass vacuously)', () => {
    expect(Object.keys(SCENARIOS).length).toBeGreaterThanOrEqual(10);
  });
});

const CLI = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'claude-code',
  'canary-question',
  'scripts',
  'cli.mjs',
);

function runMain(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    err.push(a.join(' '));
  });
  const code = main(argv);
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

describe('cli: exit codes (SC10, D10)', () => {
  it('declares its flags through the shared parser, with no --strict', () => {
    expect(CLI_SPEC.prog).toBe('canary-question');
    expect(CLI_SPEC.required).toEqual(['--test']);
    expect(Object.keys(CLI_SPEC.booleans)).toEqual(['--json']);
    expect(CLI_SPEC.values['--history']).toEqual({ key: 'history' });
  });

  it('--help exits 0 with usage on stdout', () => {
    const r = runMain(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^usage: canary-question/);
  });

  it('a missing --test is a usage error (2)', () => {
    const r = runMain([]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^canary-question: error: .*--test/);
  });

  it('a named --history that does not exist exits 1', () => {
    const r = runMain(['--test', T, '--history', path.join(tmp(), 'nope')]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^canary-question: history store not found/);
  });

  it('a named --findings that does not exist or is malformed exits 1', () => {
    const history = writeStore(tmp(), series(['passed', 'failed']));
    const missing = runMain([
      '--test',
      T,
      '--history',
      history,
      '--findings',
      path.join(tmp(), 'nope'),
    ]);
    expect(missing.code).toBe(1);
    const bad = path.join(tmp(), 'bad.json');
    fs.writeFileSync(bad, '{');
    expect(
      runMain(['--test', T, '--history', history, '--findings', bad]).code,
    ).toBe(1);
  });

  it('SC1: an abstained brief still exits 0', () => {
    const history = writeStore(tmp(), []);
    const r = runMain(['--test', T, '--history', history]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('ABSTAINED');
    expect(r.stdout).toContain('observations: 0');
  });

  it('--json prints the brief object and --out writes the same text', () => {
    const dir = tmp();
    const history = writeStore(dir, series(['passed', 'failed']));
    const out = path.join(dir, 'nested', 'brief.json');
    const r = runMain([
      '--test',
      T,
      '--history',
      history,
      '--repo',
      dir,
      '--json',
      '--out',
      out,
    ]);
    expect(r.code).toBe(0);
    const brief = JSON.parse(r.stdout);
    expect(brief.fidelity).toBe('thin');
    expect(fs.readFileSync(out, 'utf8')).toBe(r.stdout);
  });

  it('an unwritable --out exits 1', () => {
    const dir = tmp();
    const history = writeStore(dir, series(['passed', 'failed']));
    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, '');
    const r = runMain([
      '--test',
      T,
      '--history',
      history,
      '--out',
      path.join(blocker, 'x.md'),
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/cannot write artifact/);
  });

  it('SC6: --repo that is not a git repo leaves the diff Not checked', () => {
    const dir = tmp();
    const history = writeStore(dir, series(['passed', 'passed', 'failed']));
    const r = runMain([
      '--test',
      T,
      '--history',
      history,
      '--repo',
      dir,
      '--json',
    ]);
    const brief = JSON.parse(r.stdout);
    expect(brief.fidelity).toBe('history');
    expect(
      brief.not_checked.find((n: Run) => n.source === 'git diff').reason,
    ).toMatch(/git could not diff/);
  });

  it('SC5 end to end: a real test-only range reads as history+diff', () => {
    const { repo, base } = repoWithBase();
    const head = commitTouching(repo, [TEST_FILE]);
    const shas = [base, base, head];
    const history = writeStore(
      tmp(),
      series(['passed', 'passed', 'failed'], (i) => ({ commit_sha: shas[i] })),
    );
    const r = runMain([
      '--test',
      T,
      '--history',
      history,
      '--repo',
      repo,
      '--json',
    ]);
    const brief = JSON.parse(r.stdout);
    expect(r.code).toBe(0);
    expect(brief.fidelity).toBe('history+diff');
    expect(brief.hypotheses[0].for.map((x: Run) => x.signal)).toContain(
      'diff-test-only',
    );
  });

  it('a missing DEFAULT store is a dark source, exit 0 (spawned in an empty dir)', () => {
    const res = spawnSync(process.execPath, [CLI, '--test', T], {
      cwd: tmp(),
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('ABSTAINED');
    expect(res.stdout).toMatch(/run history: no history store at test-results/);
  });

  it('ships executable (the skill runner execs it via its shebang)', () => {
    expect(fs.statSync(CLI).mode & 0o111).toBeTruthy();
  });
});
