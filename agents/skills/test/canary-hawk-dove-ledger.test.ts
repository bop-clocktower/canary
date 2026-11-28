// canary-hawk-dove ledger (#618): append-only NDJSON. Existing bytes are never
// rewritten, a malformed line is counted as not read, and a symlinked ledger
// is refused.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  appendRecords,
  loadLedger,
} from '../claude-code/canary-hawk-dove/scripts/ledger.mjs';

const dirs: string[] = [];
function tmp(): string {
  const d = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'hd-ledger-')),
  );
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const REL = '.canary/hawk-dove/ledger.jsonl';
const finding = {
  v: 1,
  kind: 'finding',
  id: 'hd1-0000000000000001',
  gate: 'guardian',
  file: 'a.ts',
  rule: 'untested',
  anchor: 'f',
  fidelity: 'coverage-verified',
};
const label = {
  v: 1,
  kind: 'label',
  finding: 'hd1-0000000000000001',
  gate: 'guardian',
  outcome: 'noise',
  rule: 'explicit',
  by: 'synthetic-labeller',
  at: '2026-01-01T00:00:00.000Z',
  evidence: 'issue-1',
  note: null,
};

describe('loadLedger', () => {
  it('reports a missing ledger as missing, with an empty state', () => {
    const res = loadLedger(tmp(), REL);
    expect(res.missing).toBe(true);
    expect(res.state.findings.size).toBe(0);
  });

  it('reads findings, runs and labels', () => {
    const root = tmp();
    expect(appendRecords(root, REL, [finding, label], true)).toBeNull();
    const res = loadLedger(root, REL);
    expect(res.missing).toBe(false);
    expect([...res.state.findings.keys()]).toEqual([finding.id]);
    expect(res.state.labels).toHaveLength(1);
    expect(res.malformed).toBe(0);
  });

  it('counts malformed lines and unknown kinds as not read, never repairs them', () => {
    const root = tmp();
    const abs = path.join(root, REL);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const lines = [
      JSON.stringify(finding),
      '{oops',
      '{"v":1,"kind":"mystery"}',
      '{"v":2,"kind":"finding"}',
      '',
    ];
    const text = `${lines.join('\n')}\n`;
    fs.writeFileSync(abs, text);
    const res = loadLedger(root, REL);
    expect(res.malformed).toBe(3);
    expect(res.state.findings.size).toBe(1);
    expect(fs.readFileSync(abs, 'utf8')).toBe(text);
  });

  it('refuses a symlinked ledger', () => {
    const root = tmp();
    const outside = tmp();
    fs.writeFileSync(path.join(outside, 'l.jsonl'), JSON.stringify(finding));
    fs.mkdirSync(path.join(root, '.canary/hawk-dove'), { recursive: true });
    fs.symlinkSync(path.join(outside, 'l.jsonl'), path.join(root, REL));
    expect(loadLedger(root, REL).notRead).toBe('symlink');
  });
});

describe('appendRecords', () => {
  it('preserves every existing byte across appends', () => {
    const root = tmp();
    const abs = path.join(root, REL);
    appendRecords(root, REL, [finding], true);
    const before = fs.readFileSync(abs);
    appendRecords(root, REL, [label], true);
    const after = fs.readFileSync(abs);
    expect(after.subarray(0, before.length).equals(before)).toBe(true);
    expect(after.length).toBeGreaterThan(before.length);
  });

  it('starts a new line when the existing ledger lacks a trailing newline', () => {
    const root = tmp();
    const abs = path.join(root, REL);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify(finding));
    expect(loadLedger(root, REL).endsClean).toBe(false);
    appendRecords(root, REL, [label], false);
    const res = loadLedger(root, REL);
    expect(res.malformed).toBe(0);
    expect(res.state.labels).toHaveLength(1);
  });

  it('writes nothing for an empty batch', () => {
    const root = tmp();
    expect(appendRecords(root, REL, [], true)).toBeNull();
    expect(fs.existsSync(path.join(root, REL))).toBe(false);
  });
});
