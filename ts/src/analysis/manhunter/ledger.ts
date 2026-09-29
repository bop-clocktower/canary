/**
 * Quarantine section (#611): the canary-katana ledger of deleted and skipped
 * tests (`.canary/quarantine.json`, schema v2).
 *
 * A missing ledger is DARK: katana writes it on its first capture, so "no
 * file" means either nothing was ever removed or katana is not wired, and the
 * dossier cannot tell which. A present ledger with zero rows is fed -- katana
 * ran and recorded nothing.
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
  const entries = isRecord(parsed.value) ? parsed.value.entries : undefined;
  if (!Array.isArray(entries)) {
    return darkSection('quarantine', [ref], `${path} has no entries array`);
  }
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
