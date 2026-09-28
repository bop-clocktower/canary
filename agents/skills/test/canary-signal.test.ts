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
