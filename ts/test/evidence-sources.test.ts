/**
 * Evidence pack source readers (#855). A source that is missing, corrupt or
 * half readable is reported with its reason; it is never skipped and never
 * read as empty. Fixtures are synthetic.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildPack } from '../src/analysis/evidence/pack.js';
import {
  loadCatalogue,
  noItems,
  oneItem,
  readHistory,
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
