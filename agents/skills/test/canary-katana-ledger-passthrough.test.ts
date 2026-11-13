// Regression suite for #1569: appending to an existing quarantine ledger must
// not touch the rows katana did not create.
//
// The ledger is append-only by design, so a writer that silently drops a field
// a consumer recorded (here `scope`, which names the one config a row applies
// to) is exactly the loss the ledger exists to prevent. And a writer that
// re-indents the whole file turns a two-row append into a whole-file diff,
// which hides that loss from the reviewer who would otherwise have caught it.

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as ledger from '../claude-code/canary-katana/scripts/ledger.mjs';

const tmps: string[] = [];
const mkTmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'katana-ledger-'));
  tmps.push(d);
  return d;
};
afterEach(() => {
  while (tmps.length)
    fs.rmSync(tmps.pop() as string, { recursive: true, force: true });
});

const row = (test: string, extra: Record<string, string> = {}) => ({
  test,
  file: 'tests/test_checkout.py',
  kind: 'skipped',
  marker: 'pytest.mark.skip',
  commit: 'abc123',
  author: 'Ada Lovelace',
  date: '2026-11-01T10:00:00+00:00',
  reason: 'chore: park checkout',
  cause: 'product-defect',
  issue: 'PROJ-1',
  expiry: '',
  ...extra,
});

// An existing ledger as a consumer repo commits it: 4-space indentation, and
// rows carrying a `scope` field katana's schema does not know about -- placed
// mid-row, so a writer that re-orders keys is caught too.
const scopedAfterTest = (r: Record<string, string>, scope: string) =>
  Object.fromEntries(
    Object.entries(r).flatMap(([k, v]) =>
      k === 'test'
        ? [
            [k, v],
            ['scope', scope],
          ]
        : [[k, v]],
    ),
  );
const existingRows = [
  scopedAfterTest(row('test_a'), 'config-eu'),
  row('test_b', { scope: 'config-us' }),
];
const writeExisting = (p: string, indent: number | string = 4) =>
  fs.writeFileSync(
    p,
    `${JSON.stringify({ schema_version: 2, entries: existingRows }, null, indent)}\n`,
  );

describe('ledger append preserves rows it did not create (#1569)', () => {
  it('keeps unknown fields on existing rows', () => {
    const p = path.join(mkTmp(), 'quarantine.json');
    writeExisting(p);

    ledger.appendEntries(p, [ledger.LedgerEntry(row('test_c'))]);

    const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
    expect(onDisk.entries.map((e: { scope?: string }) => e.scope)).toEqual([
      'config-eu',
      'config-us',
      undefined,
    ]);
  });

  it('load passes unknown fields through, and keeps the v1 migration', () => {
    const p = path.join(mkTmp(), 'quarantine.json');
    fs.writeFileSync(
      p,
      JSON.stringify({
        entries: [{ test: 't', file: 'f', ticket: 'PROJ-9', scope: 's' }],
      }),
    );
    const [r] = ledger.load(p).entries as Record<string, string>[];
    expect(r.scope).toBe('s');
    expect(r.issue).toBe('PROJ-9');
    // The v1 `ticket` migrates onto `issue` rather than living alongside it.
    expect(r).not.toHaveProperty('ticket');
    expect(r.cause).toBe('');
  });

  it('an append is a diff of only the appended rows, at the file indent', () => {
    const p = path.join(mkTmp(), 'quarantine.json');
    writeExisting(p);

    const added = ledger.LedgerEntry(row('test_c'));
    ledger.appendEntries(p, [added]);

    const expected = `${JSON.stringify(
      { schema_version: 2, entries: [...existingRows, added] },
      null,
      4,
    )}\n`;
    expect(fs.readFileSync(p, 'utf8')).toBe(expected);
  });

  it('detects tab indentation too', () => {
    const p = path.join(mkTmp(), 'quarantine.json');
    writeExisting(p, '\t');
    const added = ledger.LedgerEntry(row('test_c'));
    ledger.appendEntries(p, [added]);
    expect(fs.readFileSync(p, 'utf8')).toBe(
      `${JSON.stringify(
        { schema_version: 2, entries: [...existingRows, added] },
        null,
        '\t',
      )}\n`,
    );
  });

  it('a new ledger falls back to the 2-space default', () => {
    const p = path.join(mkTmp(), '.canary', 'quarantine.json');
    const added = ledger.LedgerEntry(row('test_c'));
    ledger.appendEntries(p, [added]);
    expect(fs.readFileSync(p, 'utf8')).toBe(
      `${JSON.stringify({ schema_version: 2, entries: [added] }, null, 2)}\n`,
    );
  });

  it('a single-line (unindented) ledger also falls back to the default', () => {
    const p = path.join(mkTmp(), 'quarantine.json');
    fs.writeFileSync(
      p,
      JSON.stringify({ schema_version: 2, entries: existingRows }),
    );
    const added = ledger.LedgerEntry(row('test_c'));
    ledger.appendEntries(p, [added]);
    expect(fs.readFileSync(p, 'utf8')).toBe(
      `${JSON.stringify(
        { schema_version: 2, entries: [...existingRows, added] },
        null,
        2,
      )}\n`,
    );
  });
});
