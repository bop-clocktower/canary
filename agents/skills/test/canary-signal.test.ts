/**
 * canary-signal (#609) -- QA impact digest. Cases are tagged with the spec's
 * success criteria (SC1-SC9, docs/changes/609-canary-signal/proposal.md).
 * Fixtures are synthetic and de-identified; nothing here is copied from a
 * real store.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_LEDGER,
  loadLedger,
  loadRuns,
} from '../claude-code/canary-signal/scripts/sources.mjs';
import {
  FLAKY_CAPABLE_FORMATS,
  PRODUCTION_ESCAPES_DARK,
  THIN_SAMPLE_RUNS,
  measured,
  tallyDigest,
} from '../claude-code/canary-signal/scripts/tally.mjs';
import {
  partitionByWindow,
  resolveWindow,
} from '../claude-code/canary-signal/scripts/window.mjs';

const SCRIPTS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'claude-code',
  'canary-signal',
  'scripts',
);
const UNTIL = '2026-09-28T00:00:00.000Z';

const tmps: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-signal-'));
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
let seq = 0;
/** A RunRecord (ts/src/history/record.ts) with in-window defaults. */
function rec(over: Run = {}): Run {
  seq += 1;
  return {
    run_id: `r${seq}`,
    suite: 'unit',
    branch: 'main',
    timestamp: '2026-09-27T12:00:00Z',
    reporter_format: 'vitest',
    tests: [],
    ...over,
  };
}
const t = (test_name: string, status: string) => ({ test_name, status });

function writeStore(dir: string, runs: Run[]): string {
  const file = path.join(dir, 'history-v2.jsonl');
  const body = runs.map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(file, body ? `${body}\n` : '', 'utf8');
  return file;
}
function writeLedger(dir: string, entries: unknown): string {
  const file = path.join(dir, 'quarantine.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ schema_version: 2, entries }),
    'utf8',
  );
  return file;
}
function writeRaw(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

describe('sources.loadRuns', () => {
  it('parses one record per non-blank line, any line ending', () => {
    const body = `${JSON.stringify(rec())}\n\n${JSON.stringify(rec())}\r\n`;
    expect(loadRuns(writeRaw(tmp(), 's.jsonl', body))).toHaveLength(2);
  });
  it('throws on a missing store -- a typo must look like a typo', () => {
    expect(() => loadRuns(path.join(tmp(), 'nope.jsonl'))).toThrow(
      /history store not found/,
    );
  });
  it('names the line of a malformed record', () => {
    const body = `${JSON.stringify(rec())}\n{oops\n`;
    expect(() => loadRuns(writeRaw(tmp(), 's.jsonl', body))).toThrow(/line 2/);
  });
  it('rejects a line that parses but is not an object', () => {
    expect(() => loadRuns(writeRaw(tmp(), 's.jsonl', '[1]\n'))).toThrow(
      /line 1: not an object/,
    );
  });
});

describe('sources.loadLedger', () => {
  it('reads katana ledger entries', () => {
    const rows = [{ test: 'a', kind: 'skip' }];
    expect(loadLedger(writeLedger(tmp(), rows), true)).toEqual({
      state: 'read',
      rows,
      reason: null,
    });
  });
  it('SC6: the default path missing is a dark source, not an error', () => {
    const res = loadLedger(path.join(tmp(), DEFAULT_LEDGER), false);
    expect(res.state).toBe('dark');
    expect(res.reason).toContain('no quarantine ledger at');
  });
  it('SC6: an explicit --ledger that does not exist throws (D10)', () => {
    expect(() => loadLedger(path.join(tmp(), 'typo.json'), true)).toThrow(
      /quarantine ledger not found/,
    );
  });
  it('throws on malformed JSON', () => {
    const file = writeRaw(tmp(), 'q.json', '{nope');
    expect(() => loadLedger(file, true)).toThrow(/malformed quarantine ledger/);
  });
  it('throws on a document that is not an object', () => {
    const file = writeRaw(tmp(), 'q.json', '[]');
    expect(() => loadLedger(file, true)).toThrow(/not an object/);
  });
  it('throws when entries is not an array', () => {
    const file = writeLedger(tmp(), { a: 1 });
    expect(() => loadLedger(file, true)).toThrow(/must be an array/);
  });
  it('treats a document without entries as an empty ledger', () => {
    const file = writeRaw(tmp(), 'q.json', '{"schema_version":2}');
    expect(loadLedger(file, true).rows).toEqual([]);
  });
});

describe('window', () => {
  it('D6: spans --days ending at --until', () => {
    const w = resolveWindow(7, UNTIL).window!;
    expect(w.until.toISOString()).toBe(UNTIL);
    expect(w.since.toISOString()).toBe('2026-09-21T00:00:00.000Z');
  });
  it('defaults --until to now', () => {
    const before = Date.now();
    expect(
      resolveWindow(1, null).window!.until.getTime(),
    ).toBeGreaterThanOrEqual(before);
  });
  it('rejects an unparseable --until', () => {
    expect(resolveWindow(7, 'last tuesday').error).toMatch(/--until/);
  });
  it('rejects --days below 1', () => {
    expect(resolveWindow(0, UNTIL).error).toMatch(/--days/);
  });
  it('keeps inclusive bounds, drops outside rows, COUNTS undated ones', () => {
    const w = resolveWindow(7, UNTIL).window!;
    const items = [
      { d: '2026-09-21T00:00:00.000Z' },
      { d: UNTIL },
      { d: '2026-09-20T23:59:59Z' },
      { d: '2026-09-29T00:00:00Z' },
      { d: 'garbage' },
      {},
    ];
    const res = partitionByWindow(items, (i: { d?: string }) => i.d, w);
    expect(res.inside).toHaveLength(2);
    expect(res.undated).toBe(2);
  });
});

const WINDOW = resolveWindow(7, UNTIL).window!;
const NO_LEDGER = {
  state: 'dark',
  rows: [],
  reason: 'no quarantine ledger at .canary/quarantine.json',
};
const tally = (runs: Run[], ledger: unknown = NO_LEDGER) =>
  tallyDigest({ runs, ledger, branch: 'main', window: WINDOW });

describe('tally', () => {
  it('D4: a zero denominator abstains instead of measuring 0', () => {
    expect(measured(0, 0, 'why')).toEqual({
      abstained: true,
      reason: 'why',
    });
    expect(measured(0, 4, 'why')).toEqual({ value: 0, denominator: 4 });
  });
  it('SC2: zero runs in the window abstains the whole digest', () => {
    const old = rec({ timestamp: '2026-01-01T00:00:00Z' });
    expect(tally([old]).state).toBe('abstained');
  });
  it('SC3: 1-2 runs is a thin sample; 3 is not', () => {
    expect(THIN_SAMPLE_RUNS).toBe(3);
    expect(tally([rec(), rec()]).state).toBe('thin');
    expect(tally([rec(), rec(), rec()]).state).toBe('ok');
  });
  it('SC1: sample counts runs, suites and distinct UTC days', () => {
    const res = tally([
      rec({ suite: 'a', timestamp: '2026-09-26T01:00:00Z' }),
      rec({ suite: 'b', timestamp: '2026-09-26T02:00:00Z' }),
      rec({ suite: 'a', timestamp: '2026-09-27T01:00:00Z' }),
    ]);
    expect(res.sample).toEqual({ runs: 3, suites: 2, days: 2 });
  });
  it('counts undated runs instead of dropping them', () => {
    expect(tally([rec(), rec({ timestamp: undefined })]).undatedRuns).toBe(1);
  });
  it('tests executed: tests.length, falling back to total', () => {
    const res = tally([
      rec({ tests: [t('a', 'passed'), t('b', 'failed')] }),
      rec({ tests: undefined, total: 5 }),
      rec({ tests: undefined }),
    ]);
    expect(res.tests).toEqual({ value: 7, denominator: 3 });
  });
  it('D7: failures split by branch, distinct by test name', () => {
    const res = tally([
      rec({ branch: 'feat/x', tests: [t('a', 'failed')] }),
      rec({
        branch: 'feat/y',
        tests: [t('a', 'failed'), t('b', 'failed'), t('c', 'passed')],
      }),
      rec({ tests: [t('d', 'failed'), t('e', 'flaky')] }),
    ]);
    expect(res.preMerge).toEqual({ value: 2, denominator: 2 });
    expect(res.reached).toEqual({ value: 1, denominator: 1 });
  });
  it('SC4: no non-default-branch runs => pre-merge abstains, never 0', () => {
    const res = tally([rec(), rec(), rec()]);
    expect(res.preMerge).toMatchObject({ abstained: true });
    expect(res.preMerge).not.toHaveProperty('value');
  });
  it('reached abstains when no run is on the default branch', () => {
    expect(tally([rec({ branch: 'feat/x' })]).reached).toMatchObject({
      abstained: true,
    });
  });
  it('counts runs with no branch in neither branch line', () => {
    const res = tally([rec({ branch: undefined }), rec(), rec({ branch: '' })]);
    expect(res.unbranched).toBe(2);
    expect(res.reached).toEqual({ value: 0, denominator: 1 });
  });
  it('SC5: no flaky-capable reporter => the flaky line abstains', () => {
    const res = tally([
      rec({ tests: [t('a', 'flaky')] }),
      rec({ reporter_format: undefined }),
    ]);
    expect(res.flaky).toMatchObject({ abstained: true });
  });
  it('D8: flaky counts only over flaky-capable runs', () => {
    expect(FLAKY_CAPABLE_FORMATS).toEqual(['playwright', 'junit']);
    const res = tally([
      rec({
        reporter_format: 'playwright',
        tests: [t('a', 'flaky'), t('a', 'flaky')],
      }),
      rec({ reporter_format: 'junit' }),
      rec({ tests: [t('z', 'flaky')] }),
    ]);
    expect(res.flaky).toEqual({ value: 1, denominator: 2 });
  });
  it('SC6: a dark ledger abstains and is named as a dark source', () => {
    const res = tally([rec()]);
    expect(res.quarantine).toMatchObject({ abstained: true });
    expect(res.dark).toContain(
      'quarantine ledger: no quarantine ledger at .canary/quarantine.json',
    );
  });
  it('an empty ledger is a dark source too', () => {
    const res = tally([rec()], { state: 'read', rows: [], reason: null });
    expect(res.dark).toContain(
      'quarantine ledger: the quarantine ledger holds no entries',
    );
  });
  it('quarantine trail: rows dated in window, by kind and cause', () => {
    const rows = [
      { kind: 'skip', cause: 'flaky', date: '2026-09-25T10:00:00-05:00' },
      { kind: 'constructor', cause: '', date: '2026-09-26T00:00:00Z' },
      { kind: 'skip', cause: 'flaky', date: '2026-01-01T00:00:00Z' },
      { kind: 'skip', date: '' },
    ];
    const res = tally([rec()], { state: 'read', rows, reason: null });
    expect(res.quarantine).toEqual({
      value: 2,
      denominator: 4,
      undated: 1,
      byKind: [
        ['constructor', 1],
        ['skip', 1],
      ],
      byCause: [
        ['flaky', 1],
        ['unrecorded', 1],
      ],
    });
    expect(
      res.dark.some((d: string) => d.startsWith('quarantine ledger')),
    ).toBe(false);
  });
  it('SC7: production escapes are always a dark source', () => {
    expect(tally([rec(), rec(), rec()]).dark).toContain(
      PRODUCTION_ESCAPES_DARK,
    );
    expect(tally([]).dark).toContain(PRODUCTION_ESCAPES_DARK);
  });
});
