/**
 * canary-question (#613) -- an evidence brief for one failing test. Cases are
 * tagged with the spec's success criteria (SC1-SC11,
 * docs/changes/613-canary-question/proposal.md). Fixtures are synthetic and
 * de-identified; nothing here is copied from a real store.
 */
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
