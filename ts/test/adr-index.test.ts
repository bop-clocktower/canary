/**
 * Drift check for the ADR index (#953).
 *
 * `docs/knowledge/decisions/README.md` carries an index table, but nothing tied
 * it to the ADR files, so it stopped at 0015 while 13 more ADRs landed. The
 * index looked complete and wasn't. This test makes an ADR PR that skips the
 * index fail: every `NNNN-*.md` file must have exactly one row, and the row's
 * status must match the file's `status:` frontmatter.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DECISIONS = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'docs',
  'knowledge',
  'decisions',
);

function adrFiles(): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of readdirSync(DECISIONS)) {
    const m = /^(\d{4})-.*\.md$/.exec(name);
    if (!m) continue;
    const text = readFileSync(join(DECISIONS, name), 'utf8');
    const status = /^status:\s*(.+?)\s*$/m.exec(text)?.[1] ?? '';
    out.set(m[1] ?? '', status.replace(/^['"]|['"]$/g, ''));
  }
  return out;
}

function indexRows(): Map<string, string> {
  const readme = readFileSync(join(DECISIONS, 'README.md'), 'utf8');
  const rows = new Map<string, string>();
  for (const line of readme.split('\n')) {
    const m = /^\|\s*\[(\d{4})\]\([^)]*\)\s*\|.*\|\s*([^|]+?)\s*\|\s*$/.exec(
      line,
    );
    if (!m) continue;
    const [, num = '', status = ''] = m;
    expect(rows.has(num), `duplicate index row ${num}`).toBe(false);
    rows.set(num, status);
  }
  return rows;
}

describe('ADR index (decisions/README.md)', () => {
  it('finds ADR files to compare (a zero denominator is not a pass)', () => {
    expect(adrFiles().size).toBeGreaterThan(0);
  });

  it('lists every ADR file with its frontmatter status, and nothing else', () => {
    const files = adrFiles();
    const rows = indexRows();
    const missing = [...files.keys()].filter((n) => !rows.has(n));
    const orphaned = [...rows.keys()].filter((n) => !files.has(n));
    const wrongStatus = [...files]
      .filter(([n, s]) => rows.has(n) && rows.get(n) !== s)
      .map(([n, s]) => `${n}: index "${rows.get(n)}" vs file "${s}"`);
    expect({ missing, orphaned, wrongStatus }).toEqual({
      missing: [],
      orphaned: [],
      wrongStatus: [],
    });
  });
});
