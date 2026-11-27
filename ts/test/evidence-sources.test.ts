/**
 * Evidence pack source readers (#855). A source that is missing, corrupt or
 * half readable is reported with its reason; it is never skipped and never
 * read as empty. Fixtures are synthetic.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildPack } from '../src/analysis/evidence/pack.js';
import {
  loadCatalogue,
  noItems,
  oneItem,
  readBatwoman,
  readHistory,
  readLedger,
  typo,
} from '../src/analysis/evidence/sources.js';
import type { Scope } from '../src/analysis/evidence/types.js';
import { mkTmp, rmTmp } from './canary-cli-testkit.js';

const HISTORY = join('test-results', 'reports', 'history-v2.jsonl');
const SHA = 'a'.repeat(40);

let root: string;
let scope: Scope;

beforeEach(() => {
  root = mkTmp();
  scope = {
    since: '2026-01-01T00:00:00.000Z',
    until: '2026-06-01T00:00:00.000Z',
    root,
    out: join(root, 'out'),
    at: '2026-06-15T12:00:00.000Z',
    commit: SHA,
  };
});

afterEach(() => rmTmp(root));

function write(rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

function storedRun(id: string, timestamp?: string): Record<string, unknown> {
  return {
    run_id: id,
    suite: 'api',
    commit_sha: SHA,
    total: 3,
    passed: 2,
    failed: 1,
    flaky: 0,
    schema_version: 3,
    ...(timestamp === undefined ? {} : { timestamp }),
    tests: [{ test_name: 't1', status: 'failed', error_text: 'TOKEN=hunter2' }],
  };
}

function writeRuns(runs: Record<string, unknown>[]): void {
  write(HISTORY, runs.map((r) => `${JSON.stringify(r)}\n`).join(''));
}

describe('control catalogue', () => {
  const catalogue = loadCatalogue();
  const known = ['batwoman', 'katana', 'history', 'ci-ready'];

  it('holds the six controls of the spec, each naming known sources', () => {
    expect(catalogue.map((c) => c.id)).toEqual([
      'nist-800-40r4-2.3.3',
      'nist-800-40r4-2.3.4',
      'iso-27001-2022-a.8.8',
      'cis-v8-7',
      'soc2-cc7.1',
      'soc2-cc8.1',
    ]);
    for (const row of catalogue) {
      expect(row.sources.length, row.id).toBeGreaterThan(0);
      expect(known, row.id).toEqual(expect.arrayContaining(row.sources));
    }
  });

  it('maps every source to at least one control, so no item is unmapped', () => {
    for (const id of known) {
      const controls = catalogue.filter((c) => c.sources.some((s) => s === id));
      expect(controls.length, id).toBeGreaterThan(0);
    }
  });
});

describe('buildPack with the shipped catalogue', () => {
  it('lists the six shipped controls when no catalogue is passed', () => {
    const pack = buildPack([], scope);
    expect(pack.controls.map((c) => c.id)).toEqual(
      loadCatalogue().map((c) => c.id),
    );
    expect(pack.controls.every((c) => c.status === 'no-evidence')).toBe(true);
  });
});

describe('readHistory', () => {
  it('is absent, with the fix, when the store does not exist', () => {
    const report = readHistory(scope);
    expect(report).toMatchObject({ state: 'absent', read: 0, items: [] });
    expect(report.path).toBe(HISTORY);
    expect(report.reason).toContain('canary history record');
  });

  it('includes a run dated at since and excludes one dated at until (criterion 6)', () => {
    writeRuns([
      storedRun('before', '2025-12-31T23:59:59.999Z'),
      storedRun('at-since', '2026-01-01T00:00:00.000Z'),
      storedRun('inside', '2026-03-01T00:00:00.000Z'),
      storedRun('at-until', '2026-06-01T00:00:00.000Z'),
    ]);
    const report = readHistory(scope);
    expect(report.items.map((i) => i.ref.id)).toEqual(['at-since', 'inside']);
    expect(report).toMatchObject({ state: 'read', read: 4, inWindow: 2 });
    expect(report.reason).toBeUndefined();
  });

  it('links each run by id and commit, and carries counts but no failure text', () => {
    writeRuns([storedRun('r1', '2026-03-01T00:00:00.000Z')]);
    const [item] = readHistory(scope).items;
    expect(item?.ref).toEqual({ kind: 'run', id: 'r1', commit: SHA });
    expect(item?.summary).toContain('2 passed, 1 failed, 0 flaky of 3');
    expect(JSON.stringify(item)).not.toContain('hunter2');
  });

  it('is unreadable, naming the line, when the store is corrupt (criterion 2)', () => {
    const good = JSON.stringify(storedRun('r1', '2026-03-01T00:00:00.000Z'));
    write(HISTORY, `${good}\n{not json\n`);
    const report = readHistory(scope);
    expect(report).toMatchObject({ state: 'unreadable', read: 0, items: [] });
    expect(report.reason).toContain('line 2');
  });

  it('is unreadable, naming the errno, when the store is a directory', () => {
    mkdirSync(join(root, HISTORY), { recursive: true });
    const report = readHistory(scope);
    expect(report.state).toBe('unreadable');
    expect(report.reason).toContain('EISDIR');
  });

  it('is partial when a run has no usable date, and places it nowhere', () => {
    writeRuns([
      storedRun('dated', '2026-03-01T00:00:00.000Z'),
      storedRun('undated'),
      storedRun('garbled', 'last tuesday'),
    ]);
    const report = readHistory(scope);
    expect(report).toMatchObject({ state: 'partial', read: 3, undated: 2 });
    expect(report.items.map((i) => i.ref.id)).toEqual(['dated']);
    expect(report.reason).toContain('2 record(s) have no usable date');
  });
});

describe('source helpers the CLI builds ci-ready with', () => {
  it('builds a one-item report with a commit URL when the repository is known', () => {
    const src = {
      id: 'ci-ready' as const,
      path: '.',
      scope: { ...scope, repo: 'acme/widgets' },
    };
    const ref = { kind: 'commit' as const, id: SHA };
    const report = oneItem(src, { date: scope.at, summary: 'scored', ref });
    expect(report).toMatchObject({ state: 'read', read: 1, inWindow: 1 });
    expect(report.items[0]).toEqual({
      source: 'ci-ready',
      at: scope.at,
      summary: 'scored',
      ref: { ...ref, url: `https://github.com/acme/widgets/commit/${SHA}` },
    });
  });

  it('builds no URL without a repository, or from a malformed slug', () => {
    const ref = { kind: 'commit' as const, id: SHA };
    const raw = { date: scope.at, summary: 'scored', ref };
    const bare = oneItem({ id: 'ci-ready', path: '.', scope }, raw);
    const odd = { ...scope, repo: 'acme/widgets/../x' };
    const bad = oneItem({ id: 'ci-ready', path: '.', scope: odd }, raw);
    expect(bare.items[0]?.ref.url).toBeUndefined();
    expect(bad.items[0]?.ref.url).toBeUndefined();
  });

  it('reports a source with no items under the state and reason given', () => {
    const src = { id: 'ci-ready' as const, path: '.', scope };
    expect(noItems(src, 'out-of-window', 'scored outside')).toEqual({
      id: 'ci-ready',
      path: '.',
      state: 'out-of-window',
      reason: 'scored outside',
      read: 0,
      inWindow: 0,
      undated: 0,
      items: [],
    });
  });
});

const LEDGER = join('.canary', 'quarantine.json');
const REPORTS = join('.canary', 'batwoman');

function ledgerRow(
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    test: 'adds a widget',
    file: 'tests/widgets.test.ts',
    kind: 'skipped',
    marker: 'it.skip',
    commit: 'b'.repeat(40),
    author: 'Sam Example',
    date: '2026-03-01T10:00:00Z',
    reason: 'chore: skip the widget test',
    cause: 'blocked-data',
    issue: '#12',
    expiry: '',
    ...over,
  };
}

function savedReport(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    issue: 12,
    pullRequest: 34,
    repo: 'acme/widgets',
    mergeSha: 'c'.repeat(40),
    mergeSubject: 'fix: widget totals',
    mergedAt: '2026-02-01T00:00:00.000Z',
    summary: { changed: 2, byStatus: { 'not-exercised': 2 } },
    files: [
      { file: 'src/a.ts', status: 'not-exercised', explanation: 'no run' },
      { file: 'src/b.ts', status: 'not-exercised', explanation: 'no run' },
    ],
    ...over,
  });
}

describe('readLedger', () => {
  it('is absent when there is no ledger', () => {
    const report = readLedger(scope);
    expect(report).toMatchObject({ state: 'absent', read: 0 });
    expect(report.reason).toContain(LEDGER);
  });

  it('turns each row in the window into an item with owner, reason and link', () => {
    const rows = [ledgerRow(), ledgerRow({ test: 'old', date: '2025-06-01' })];
    write(LEDGER, JSON.stringify({ schema_version: 2, entries: rows }));
    const report = readLedger(scope);
    expect(report).toMatchObject({ state: 'read', read: 2, inWindow: 1 });
    expect(report.items[0]?.ref).toEqual({
      kind: 'ledger-entry',
      id: 'tests/widgets.test.ts::adds a widget',
      commit: 'b'.repeat(40),
    });
    expect(report.items[0]?.summary).toBe(
      'skipped adds a widget in tests/widgets.test.ts by Sam Example: blocked-data',
    );
  });

  it('reads an empty v2 ledger as read with nothing recorded', () => {
    write(LEDGER, JSON.stringify({ schema_version: 2, entries: [] }));
    expect(readLedger(scope)).toMatchObject({ state: 'read', read: 0 });
  });

  it.each([
    ['not JSON', '{nope', 'not valid JSON'],
    ['a v1 ledger', JSON.stringify({ entries: [] }), 'katana v2 ledger'],
    ['no entries array', '{"schema_version":2}', 'katana v2 ledger'],
  ])('is unreadable when the file is %s', (_name, text, reason) => {
    write(LEDGER, text);
    const report = readLedger(scope);
    expect(report.state).toBe('unreadable');
    expect(report.reason).toContain(reason);
  });

  it('is partial when a row has no date or no file and test to link to', () => {
    const rows = [
      ledgerRow(),
      ledgerRow({ date: '' }),
      ledgerRow({ file: '' }),
    ];
    write(LEDGER, JSON.stringify({ schema_version: 2, entries: rows }));
    const report = readLedger(scope);
    expect(report).toMatchObject({ state: 'partial', inWindow: 1, undated: 1 });
    expect(report.reason).toContain('1 record(s) have no usable date');
    expect(report.reason).toContain('1 record(s) have no identifier');
  });
});

describe('readBatwoman', () => {
  it('is absent, with the command that saves a report, when the directory is missing or empty', () => {
    const missing = readBatwoman(scope);
    mkdirSync(join(root, REPORTS), { recursive: true });
    write(join(REPORTS, 'notes.txt'), 'not a report');
    const empty = readBatwoman(scope);
    for (const report of [missing, empty]) {
      expect(report.state).toBe('absent');
      expect(report.reason).toContain('canary batwoman --issue <n> --json');
    }
  });

  it('lists a not-exercised report as an item with its statuses (criterion 11)', () => {
    write(join(REPORTS, '12.json'), savedReport());
    const report = readBatwoman(scope);
    expect(report).toMatchObject({ state: 'read', read: 1, inWindow: 1 });
    expect(report.items[0]?.summary).toBe(
      'issue #12 (PR #34) from 12.json: not-exercised: 2',
    );
    expect(report.items[0]?.ref).toEqual({
      kind: 'commit',
      id: 'c'.repeat(40),
      url: `https://github.com/acme/widgets/commit/${'c'.repeat(40)}`,
    });
  });

  it('keeps two reports for one issue as two items, each naming its file', () => {
    write(join(REPORTS, '12-a.json'), savedReport());
    write(join(REPORTS, '12-b.json'), savedReport());
    const summaries = readBatwoman(scope).items.map((i) => i.summary);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toContain('12-a.json');
    expect(summaries[1]).toContain('12-b.json');
  });

  it('is partial, naming the file, when one report is malformed', () => {
    write(join(REPORTS, '12.json'), savedReport());
    write(join(REPORTS, '13.json'), '{broken');
    write(join(REPORTS, '14.json'), JSON.stringify({ issue: 14 }));
    const report = readBatwoman(scope);
    expect(report).toMatchObject({ state: 'partial', read: 1, inWindow: 1 });
    expect(report.reason).toContain('13.json: not valid JSON');
    expect(report.reason).toContain('14.json: lacks issue, mergeSha');
  });

  it('is unreadable, naming the errno, when the directory cannot be listed', () => {
    write(REPORTS, 'a file where the directory should be');
    const report = readBatwoman(scope);
    expect(report.state).toBe('unreadable');
    expect(report.reason).toContain('ENOTDIR');
  });

  it('names a report it has no permission to read and still reads the rest', () => {
    write(join(REPORTS, '12.json'), savedReport());
    write(join(REPORTS, '13.json'), savedReport({ issue: 13 }));
    chmodSync(join(root, REPORTS, '13.json'), 0o000);
    const report = readBatwoman(scope);
    expect(report).toMatchObject({ state: 'partial', read: 1 });
    expect(report.reason).toContain('13.json: could not be read (EACCES)');
  });
});

describe('typo', () => {
  it('finds nothing wrong with an existing root and no typed values', () => {
    expect(typo(scope)).toBeNull();
  });

  it('names a root that does not exist', () => {
    const gone = join(root, 'no-such-root');
    expect(typo({ ...scope, root: gone })).toBe(`${gone} does not exist`);
  });

  it('names a typed batwoman directory that does not exist', () => {
    const gone = join(root, 'batwomann');
    expect(typo({ ...scope, batwoman: gone })).toBe(`${gone} does not exist`);
  });

  it('names a repository that is not an owner/name slug', () => {
    expect(typo({ ...scope, repo: 'acme' })).toBe(
      'acme is not an owner/name slug',
    );
    expect(typo({ ...scope, repo: 'acme/widgets' })).toBeNull();
  });
});

describe('readBatwoman with a typed directory', () => {
  it('reads the directory where it was typed and labels the source with it', () => {
    const dir = join(root, 'saved');
    write(join('saved', '12.json'), savedReport());
    const report = readBatwoman({ ...scope, batwoman: dir });
    expect(report).toMatchObject({ path: dir, state: 'read', inWindow: 1 });
  });
});
