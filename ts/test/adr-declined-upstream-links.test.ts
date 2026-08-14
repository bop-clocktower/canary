/**
 * A declined check that waits on an upstream fix must name the upstream ticket
 * (#719).
 *
 * ADR 0014's Declined table is the register of harness checks this repo has
 * deliberately not wired. Several rows are declined *conditionally* — they say,
 * in the revisit column, that the answer changes when somebody else fixes
 * something. That is the most perishable kind of decision in the document: the
 * upstream fix lands, and nothing here points at the thing whose state would
 * tell you.
 *
 * #719 is the instance. `scan-config` was declined pending an upstream
 * false-positive fix, the fix was filed and merged upstream, and the only
 * record of the ticket number lived in a GitHub issue comment — so the ADR
 * still read as "blocked indefinitely" while the block had actually moved to
 * "merged, awaiting a published release". The issue's last open checkbox was
 * precisely "record it in `docs/`, with a link to the upstream issue".
 *
 * The invariant: if a Declined row's revisit condition depends on **upstream**,
 * the row must name an upstream ticket, so the condition is checkable by
 * following a link rather than by remembering a conversation.
 *
 * Offline: reads one Markdown file. Never runs `harness` and never hits the
 * network — the check is that a reference *exists*, not that it is open.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ADR = join(
  REPO_ROOT,
  'docs',
  'knowledge',
  'decisions',
  '0014-harness-check-wiring-register.md',
);

/** `harness-engineering#1343`, `harness-engineering #1012` — either spacing. */
const UPSTREAM_REF = /harness-engineering\s*#\d+/;

/** One row of the Declined table, split on its pipe delimiters. */
interface DeclinedRow {
  command: string;
  rationale: string;
  revisitWhen: string;
}

/**
 * The Declined table's data rows.
 *
 * Located by its `### Declined` heading and terminated by the next heading, so
 * the parser cannot silently drift onto a different table if the document is
 * reorganised — it would find no rows, which the denominator assertion catches.
 */
function parseDeclinedRows(markdown: string): DeclinedRow[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l.trim() === '### Declined');
  if (start === -1) return [];

  const rows: DeclinedRow[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('#')) break;
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1);
    if (cells.length < 3) continue;
    const [command, rationale, revisitWhen] = cells.map((c) => c.trim());
    if (!command || /^-+$/.test(command)) continue; // header separator
    rows.push({
      command,
      rationale: rationale ?? '',
      revisitWhen: revisitWhen ?? '',
    });
  }
  return rows;
}

describe('ADR 0014 Declined rows are checkable (#719)', () => {
  const rows = parseDeclinedRows(readFileSync(ADR, 'utf-8'));

  it('parses the Declined table', () => {
    // Without this, a parser that silently found nothing would report every
    // row compliant — the false green this whole register exists to avoid.
    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect(rows.map((r) => r.command)).toContain('`scan-config`');
  });

  it('names an upstream ticket on every row whose revisit depends on upstream', () => {
    const offenders = rows
      .filter((r) => /upstream/i.test(r.revisitWhen))
      .filter((r) => !UPSTREAM_REF.test(`${r.rationale} ${r.revisitWhen}`))
      .map((r) => r.command);
    expect(offenders).toEqual([]);
  });
});
