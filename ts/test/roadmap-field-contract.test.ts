/**
 * The one-line field contract for `docs/roadmap.md` (#628).
 *
 * `docs/roadmap.md` is machine-managed: harness's roadmap tooling parses each
 * `- **Key:** value` field by reading ONE physical line. The contract is stated
 * in the file's own header comment. When a field value gets wrapped across
 * lines, harness keeps the first line and silently discards the rest — no
 * error on either side. A round-trip through `harness roadmap shard` + `regen`
 * took the file from 40,525 bytes to 11,640 (2026-08-07). The file looked
 * maintained the whole time.
 *
 * Two writers with different rules touch this file, which is why the drift is
 * not a one-off:
 *
 *   - Agent edits go through `.harness/hooks/quality-warner.js`, which runs
 *     `prettier --check` on every write and blocks on violation. Prettier's
 *     `proseWrap: "always"` considers a long single-line field a violation, so
 *     the hook actively FORCES the wrapped (broken) shape — until
 *     `docs/roadmap.md` is listed in `.prettierignore`, which is why that entry
 *     is a precondition for the repair rather than tidy-up.
 *   - `scripts/roadmap-sync.mjs` and `scripts/roadmap-groom.mjs` write the file
 *     directly and bypass the hook entirely.
 *
 * No CI job formats or checks `docs/` at all — the format gate is scoped to
 * `ts/` and `agents/skills/`. So this test is the only thing in the repo that
 * FAILS on a wrapped field. The `.prettierignore` entry unblocks writing the
 * corrected file; it cannot detect anything. This test detects; it cannot
 * unblock anything. Both are required and they are not redundant.
 *
 * Denominator, per the repo's no-silent-abstention convention (#508, #595):
 * a scan that inspects ZERO fields fails as an abstention rather than passing
 * vacuously. A parser that silently stops matching — the exact failure this
 * file exists to catch — must not look like a clean file.
 *
 * Offline: reads `docs/roadmap.md` as text. Never invokes harness.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROADMAP = join(REPO_ROOT, 'docs', 'roadmap.md');

/** A field line: `- **Summary:** ...`. Group 1 is the field name. */
const FIELD = /^- \*\*(\w[\w -]*):\*\*/;
/** A field line with its value captured: group 1 name, group 2 value. */
const FIELD_VALUE = /^- \*\*(\w[\w -]*):\*\*\s*(.*)$/;
/** The priority enum, fixed by the upstream harness roadmap schema. */
const PRIORITY = /^P[0-3]$/;
/** A markdown ATX heading, at any level. */
const HEADING = /^#{1,6}\s/;
/** The start of an HTML comment block. */
const COMMENT = /^<!--/;
/** A row heading: `### Some row name`. */
const ROW = /^###\s+(.*)$/;

interface Violation {
  /** 1-indexed line number of the offending continuation line. */
  line: number;
  /** The `### ` row the field belongs to, or `'(no row)'` before the first. */
  row: string;
  /** The field name whose value was wrapped. */
  field: string;
  /** The continuation text harness would silently discard. */
  discarded: string;
}

interface ScanResult {
  /** The denominator: how many field lines the scan actually matched. */
  fieldsInspected: number;
  violations: Violation[];
}

/**
 * Enforce the grammar positively — the field regex alone describes what a
 * field looks like, not what a violation looks like, so the rejection rule is
 * spelled out rather than left to an unwritten reading.
 *
 * The line after a field line must be one of: another field line, a blank
 * line, a heading, an HTML comment, or EOF. Any other non-blank line is a
 * continuation, and a continuation is exactly the text harness drops.
 */
function scanFieldContract(text: string): ScanResult {
  const lines = text.split('\n');
  const violations: Violation[] = [];
  let fieldsInspected = 0;
  let row = '(no row)';

  for (let i = 0; i < lines.length; i++) {
    const rowMatch = ROW.exec(lines[i]);
    if (rowMatch) {
      row = rowMatch[1].trim();
      continue;
    }

    const fieldMatch = FIELD.exec(lines[i]);
    if (!fieldMatch) continue;
    fieldsInspected++;

    const next = lines[i + 1];
    if (next === undefined) continue; // EOF
    if (next.trim() === '') continue;
    if (FIELD.test(next)) continue;
    if (HEADING.test(next)) continue;
    if (COMMENT.test(next)) continue;

    violations.push({
      line: i + 2,
      row,
      field: fieldMatch[1],
      discarded: next.trim(),
    });
  }

  return { fieldsInspected, violations };
}

interface Row {
  /** The `### ` heading text. */
  name: string;
  /** 1-indexed line of the heading. */
  line: number;
  /** Field name to raw value, for the fields this row declares. */
  fields: Map<string, string>;
}

/**
 * Split the roadmap into rows. A row runs from its `### ` heading to the next
 * heading of any level, so a row cannot silently absorb the fields of the row
 * or section below it.
 */
function scanRows(text: string): Row[] {
  const rows: Row[] = [];
  const lines = text.split('\n');
  let current: Row | undefined;

  for (let i = 0; i < lines.length; i++) {
    const rowMatch = ROW.exec(lines[i]);
    if (rowMatch) {
      current = { name: rowMatch[1].trim(), line: i + 1, fields: new Map() };
      rows.push(current);
      continue;
    }
    if (HEADING.test(lines[i])) {
      current = undefined; // a section heading ends the row
      continue;
    }
    if (!current) continue;

    const fieldMatch = FIELD_VALUE.exec(lines[i]);
    if (fieldMatch) current.fields.set(fieldMatch[1], fieldMatch[2].trim());
  }

  return rows;
}

/** Render violations as a message that names the row and field, not just a count. */
function describeViolations(v: Violation[]): string {
  return v
    .map(
      (x) =>
        `  docs/roadmap.md:${x.line} — row "${x.row}", field "${x.field}" is ` +
        `wrapped; harness discards: "${x.discarded.slice(0, 60)}…"`,
    )
    .join('\n');
}

const CLEAN = [
  '## Section',
  '',
  '### A row',
  '',
  '- **Status:** backlog',
  '- **Summary:** one physical line, however long it happens to run, because that is the contract.',
  '- **External-ID:** github:bop-clocktower/canary#1',
  '',
  '### Another row',
  '',
  '- **Status:** done',
  '',
  '<!-- a trailing comment -->',
].join('\n');

const WRAPPED = [
  '### A row',
  '',
  '- **Status:** backlog',
  '- **Summary:** this value was wrapped by a prose formatter and so',
  '  everything on this line is invisible to harness.',
  '- **External-ID:** github:bop-clocktower/canary#1',
].join('\n');

describe('roadmap one-line field contract', () => {
  describe('the detector', () => {
    it('accepts fields that are a single physical line', () => {
      const result = scanFieldContract(CLEAN);

      expect(result.violations).toEqual([]);
      expect(result.fieldsInspected).toBe(4);
    });

    it('names the row, the field, and the text harness would discard', () => {
      const result = scanFieldContract(WRAPPED);

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]).toMatchObject({
        line: 5,
        row: 'A row',
        field: 'Summary',
      });
      expect(result.violations[0].discarded).toContain('invisible to harness');
    });

    it('treats a heading, a comment, a blank line, and EOF as terminators', () => {
      // Each of these follows a field line and must NOT read as a continuation.
      const terminators = [
        '- **Status:** x\n\n- **Other:** y',
        '- **Status:** x\n## Next section',
        '- **Status:** x\n<!-- note -->',
        '- **Status:** x',
      ];

      for (const text of terminators) {
        expect(scanFieldContract(text).violations).toEqual([]);
      }
    });

    it('reports a zero denominator rather than a clean result', () => {
      // The failure this whole file guards against: a parser that stops
      // matching looks identical to a spotless file unless the count is
      // asserted. Zero fields inspected is an abstention, not a pass.
      const result = scanFieldContract('# Roadmap\n\nNo fields here at all.\n');

      expect(result.violations).toEqual([]);
      expect(result.fieldsInspected).toBe(0);
    });
  });

  describe('the row parser', () => {
    it('reads each row-s fields and stops at the next heading', () => {
      const rows = scanRows(CLEAN);

      expect(rows.map((r) => r.name)).toEqual(['A row', 'Another row']);
      expect(rows[0].fields.get('Status')).toBe('backlog');
      expect(rows[0].fields.get('External-ID')).toBe(
        'github:bop-clocktower/canary#1',
      );
      // The second row declares only Status — it must not inherit the first-s.
      expect([...rows[1].fields.keys()]).toEqual(['Status']);
    });
  });

  describe('docs/roadmap.md', () => {
    const text = readFileSync(ROADMAP, 'utf8');
    const result = scanFieldContract(text);
    const rows = scanRows(text);

    it('inspects a non-zero number of fields', () => {
      // Denominator first: without this, every assertion below passes
      // vacuously the day the field syntax changes.
      expect(result.fieldsInspected).toBeGreaterThan(0);
    });

    it('has no field value wrapped across lines', () => {
      expect(
        result.violations,
        `${result.violations.length} wrapped field(s) — harness silently ` +
          `discards the continuation of each:\n${describeViolations(result.violations)}`,
      ).toEqual([]);
    });

    it('parses a non-zero number of rows', () => {
      // Same denominator reasoning as the field count: a row parser that
      // matches nothing would make every per-row assertion below vacuous.
      expect(rows.length).toBeGreaterThan(0);
    });

    it('gives every row a Priority in the schema-s enum', () => {
      // P0-P3 is fixed upstream and hard-fails on read, so an out-of-enum
      // value is not a style question — it breaks `harness roadmap` outright.
      const bad = rows.filter(
        (r) => !PRIORITY.test(r.fields.get('Priority') ?? ''),
      );

      expect(
        bad.map(
          (r) =>
            `docs/roadmap.md:${r.line} "${r.name}" -> ` +
            `${JSON.stringify(r.fields.get('Priority') ?? '(absent)')}`,
        ),
        `${bad.length} of ${rows.length} row(s) lack a valid Priority (P0-P3)`,
      ).toEqual([]);
    });
  });
});
