import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NdjsonHistoryStore } from '../ndjson-store.js';
import { SCHEMA_VERSION } from '../record.js';
import { trimStoreToNewest } from './trim.js';

let dir: string;

function writeHistory(lines: object[], raw?: string): string {
  const path = join(dir, 'history-v2.jsonl');
  const body = raw ?? lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  writeFileSync(path, body, 'utf-8');
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canary-trim-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// #1024: retention. `pushRun` stays append-only and unbounded -- the trim is a
// separate, caller-invoked operation, so nothing a consumer records is dropped
// behind their back. These pin the boundary (a store at exactly `keep` is
// untouched) because an off-by-one here silently deletes a run a reader wanted.
describe('trimStoreToNewest', () => {
  function runsAt(count: number, from = 1): object[] {
    return Array.from({ length: count }, (_, i) => ({
      run_id: `r${from + i}`,
      suite: 'api',
      schema_version: SCHEMA_VERSION,
      timestamp: `2026-09-${String(from + i).padStart(2, '0')}T00:00:00Z`,
    }));
  }

  it('is a no-op on a missing file rather than throwing', () => {
    expect(trimStoreToNewest(join(dir, 'missing.jsonl'), 50)).toEqual({
      before: 0,
      after: 0,
      removed: 0,
    });
  });

  it('leaves a store BELOW the keep count byte-identical', () => {
    const path = writeHistory(runsAt(3));
    const before = readFileSync(path, 'utf-8');

    expect(trimStoreToNewest(path, 50)).toEqual({
      before: 3,
      after: 3,
      removed: 0,
    });
    expect(readFileSync(path, 'utf-8')).toBe(before);
  });

  // The boundary: a store of exactly `keep` must lose nothing AND must not be
  // rewritten at all -- the failure mode guarded is a `<` that should be `<=`.
  //
  // The bytes here are deliberately NOT what a rewrite would produce (blank
  // lines between rows). A canonical fixture survives the off-by-one unchanged
  // and the test passes over the bug -- probed by mutating `<=` to `<`, which
  // this catches and a canonical fixture did not.
  it('leaves a store at EXACTLY the keep count byte-identical', () => {
    const noisy =
      runsAt(10)
        .map((l) => JSON.stringify(l))
        .join('\n\n') + '\n\n';
    const path = writeHistory([], noisy);

    expect(trimStoreToNewest(path, 10)).toEqual({
      before: 10,
      after: 10,
      removed: 0,
    });
    expect(readFileSync(path, 'utf-8')).toBe(noisy);
  });

  it('keeps the newest `keep` runs when the store is ABOVE the count', () => {
    const path = writeHistory(runsAt(14));

    expect(trimStoreToNewest(path, 10)).toEqual({
      before: 14,
      after: 10,
      removed: 4,
    });
    expect(new NdjsonHistoryStore(path).readAll().map((r) => r.run_id)).toEqual(
      ['r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14'],
    );
  });

  // Same rule `queryFlaky` and `querySummary` already apply (#604): "newest"
  // means TIME order, not append order. A backfilled older run appended last
  // must not survive a trim that drops a genuinely newer one.
  it('ranks by timestamp, not by position in the file', () => {
    const path = writeHistory([
      { run_id: 'newest', suite: 'api', timestamp: '2026-09-30T00:00:00Z' },
      { run_id: 'oldest', suite: 'api', timestamp: '2026-09-01T00:00:00Z' },
      { run_id: 'middle', suite: 'api', timestamp: '2026-09-15T00:00:00Z' },
    ]);

    expect(trimStoreToNewest(path, 2).removed).toBe(1);
    expect(
      new Set(new NdjsonHistoryStore(path).readAll().map((r) => r.run_id)),
    ).toEqual(new Set(['middle', 'newest']));
  });

  // Rewriting from the PARSED record would drop any field this version does not
  // model -- a silent data loss on a store written by a newer canary. The
  // surviving lines must be the original bytes.
  it('preserves each surviving row as its original bytes', () => {
    const path = writeHistory(
      [],
      '{"run_id":"a","timestamp":"2026-09-01T00:00:00Z"}\n' +
        '{"run_id":"b","timestamp":"2026-09-02T00:00:00Z","a_field_we_do_not_model":42}\n',
    );

    trimStoreToNewest(path, 1);
    expect(readFileSync(path, 'utf-8')).toBe(
      '{"run_id":"b","timestamp":"2026-09-02T00:00:00Z","a_field_we_do_not_model":42}\n',
    );
  });

  it('keeps countRuns() honest after a trim', () => {
    const path = writeHistory(runsAt(20));
    trimStoreToNewest(path, 12);
    expect(new NdjsonHistoryStore(path).countRuns()).toBe(12);
  });
});
