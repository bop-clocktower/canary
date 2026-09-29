/**
 * Quarantine section (#611): the canary-katana ledger of deleted and skipped
 * tests (`.canary/quarantine.json`, schema v2).
 *
 * The denominator here is "katana ran", not a row count. katana writes the
 * ledger on EVERY scan that is not `--no-write`, including one that found no
 * deletions (canary-katana `scripts/cli.mjs`, `appendEntries` with an empty
 * batch still writes `{schema_version: 2, entries: []}`). So a present v2
 * ledger with zero rows is a real "katana looked and recorded nothing", and is
 * fed; a missing ledger is DARK, because "nothing was ever removed" and
 * "katana is not wired" cannot be told apart. A file without katana's
 * `schema_version: 2` stamp is refused, not trusted as a ledger.
 */

import { parseJsonSource, readSource, sourceRef } from './sources.js';
import { darkSection, fedSection, isRecord, type Section } from './types.js';

/** Mirrors CAUSES_REQUIRING_ISSUE in canary-katana's ledger.mjs. */
const CAUSES_REQUIRING_ISSUE = ['product-defect', 'blocked-data'];

interface LedgerRow {
  test: string;
  file: string;
  kind: string;
  cause: string;
  issue: string;
  expiry: string;
}

function toRow(raw: unknown): LedgerRow {
  const r = isRecord(raw) ? raw : {};
  const field = (k: string) => (typeof r[k] === 'string' ? r[k] : '');
  return {
    test: field('test') || '?',
    file: field('file') || '?',
    kind: field('kind'),
    cause: field('cause'),
    issue: field('issue'),
    expiry: field('expiry'),
  };
}

function isExpired(expiry: string, nowMs: number): boolean {
  const at = Date.parse(expiry);
  return expiry !== '' && !Number.isNaN(at) && at < nowMs;
}

function rowEyes(row: LedgerRow, nowMs: number): string[] {
  const who = `${row.test} (${row.file})`;
  const eyes: string[] = [];
  if (CAUSES_REQUIRING_ISSUE.includes(row.cause) && row.issue === '') {
    eyes.push(`${who}: out as ${row.cause} with no linked issue`);
  }
  if (isExpired(row.expiry, nowMs)) {
    eyes.push(`${who}: quarantine expired ${row.expiry}`);
  }
  if (row.kind === 'removed' && row.cause === '') {
    eyes.push(`${who}: removed with no stated cause`);
  }
  return eyes;
}

function tally(rows: LedgerRow[], key: 'kind' | 'cause'): string {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = r[key] || '(none)';
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].map(([k, n]) => `${k}: ${n}`).join(', ');
}

export function ledgerSection(path: string, nowIso: string): Section {
  const read = readSource(path);
  const ref = sourceRef(read);
  if (read.kind === 'missing') {
    return darkSection(
      'quarantine',
      [ref],
      `no katana ledger at ${path}; "nothing was ever removed" and "katana is not wired" cannot be told apart`,
    );
  }
  const parsed = parseJsonSource(read);
  if (!parsed.ok) return darkSection('quarantine', [ref], parsed.reason);
  const doc = isRecord(parsed.value) ? parsed.value : {};
  if (doc.schema_version !== 2 || !Array.isArray(doc.entries)) {
    return darkSection(
      'quarantine',
      [ref],
      `${path} is not a katana v2 ledger (needs schema_version 2 and an entries array)`,
    );
  }
  const entries: unknown[] = doc.entries;
  const rows = entries.map(toRow);
  const nowMs = Date.parse(nowIso);
  const facts =
    rows.length === 0
      ? ['katana has recorded no deleted or skipped tests']
      : [
          `by kind: ${tally(rows, 'kind')}`,
          `by cause: ${tally(rows, 'cause')}`,
        ];
  return fedSection('quarantine', {
    sources: [ref],
    denominator: `${rows.length} ledger row${rows.length === 1 ? '' : 's'}`,
    facts,
    eyes: rows.flatMap((r) => rowEyes(r, nowMs)),
  });
}
