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

/**
 * Drift check for the markdownlint directive the ADRs carry (#1099).
 *
 * The README's Format section quoted `markdownlint-disable-next-line MD025`
 * while all 33 shipped ADRs carried `markdownlint-disable-file MD025`, and then
 * justified the choice as "per-file and per-rule deliberately" — describing the
 * directive in the files, not the one in the sample. Nothing tied the two
 * together, so the sample was free to drift for 33 files.
 *
 * The failure this guards is quiet rather than loud: an author following the
 * README gets a line-scoped directive, and because a frontmatter `title:`
 * collides with the `# ADR NNNN` H1 it would most likely still satisfy MD025 —
 * passing CI while diverging from every sibling. A convention that breaks
 * silently is how one convention becomes two.
 *
 * Both halves are asserted on purpose. Checking only the files would let the
 * README rot again; checking only the README would let a stray ADR use
 * something else.
 */
const MD025_DIRECTIVE = '<!-- markdownlint-disable-file MD025 -->';

describe('ADR markdownlint directive (README matches the files)', () => {
  const names = readdirSync(DECISIONS)
    .filter((n) => /^\d{4}-.*\.md$/.test(n))
    .sort();

  it('finds ADR files to check (a zero denominator is not a pass)', () => {
    expect(names.length).toBeGreaterThan(0);
  });

  it('has every ADR carry the rule-scoped file directive', () => {
    const offenders = names.filter(
      (n) =>
        !readFileSync(join(DECISIONS, n), 'utf8').includes(MD025_DIRECTIVE),
    );
    expect(
      offenders,
      `these ADRs do not carry ${MD025_DIRECTIVE}. Every ADR suppresses MD025 ` +
        `file-wide and by rule name, because a frontmatter 'title:' reads as a ` +
        `top-level heading and protect-config.js forbids weakening ` +
        `.markdownlint.json repo-wide.`,
    ).toEqual([]);
  });

  it('documents in the README the exact directive the ADRs use', () => {
    const readme = readFileSync(join(DECISIONS, 'README.md'), 'utf8');
    expect(
      readme.includes('markdownlint-disable-file MD025'),
      `README.md's Format section must quote the directive the ADRs actually ` +
        `carry (${MD025_DIRECTIVE}). It once documented ` +
        `'markdownlint-disable-next-line MD025', which is line-scoped and ` +
        `contradicted its own "per-file and per-rule" rationale.`,
    ).toBe(true);
    expect(
      readme.includes('markdownlint-disable-next-line MD025'),
      `README.md still quotes the stale line-scoped directive; the ADRs use ` +
        `the file-scoped one.`,
    ).toBe(false);
  });
});
