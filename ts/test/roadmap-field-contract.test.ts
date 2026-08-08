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
 * Three writers with different rules touch this file, which is why the drift
 * is not a one-off:
 *
 *   - Agent edits go through `.harness/hooks/quality-warner.js`, which runs
 *     `prettier --check` on every write and blocks on violation. Prettier's
 *     `proseWrap: "always"` considers a long single-line field a violation, so
 *     the hook actively FORCES the wrapped (broken) shape — until
 *     `docs/roadmap.md` is listed in `.prettierignore`, which is why that entry
 *     is a precondition for the repair rather than tidy-up.
 *   - `scripts/roadmap-sync.mjs` and `scripts/roadmap-groom.mjs` write the file
 *     directly and bypass the hook entirely.
 *   - `harness roadmap promote` rewrites `Summary` from a spec document, and is
 *     also the command that strips the header comment (canary#273).
 *
 * No CI job FORMATS `docs/`, but one does LINT it: `markdownlint` in
 * `.github/workflows/docs-lint.yml` globs every markdown file in the repo with
 * no path filter and is a REQUIRED check in
 * `.github/required-checks.json`. It passes only because
 * `docs/roadmap.md` carries a `markdownlint-disable-file MD013` comment — with
 * that comment removed the file reports 51 line-length errors and a required
 * check goes red. That comment is therefore load-bearing on a merge gate, and
 * it is asserted below rather than left to a local-only hook.
 *
 * Denominator, per the repo's no-silent-abstention convention (#508, #595):
 * a scan that inspects ZERO fields fails as an abstention rather than passing
 * vacuously. But non-zero is not enough — a scanner can match SOME fields and
 * silently skip the rest, which reads exactly like a clean file. So the scan
 * counts two things: field-SHAPED lines (permissive) and fields actually
 * INSPECTED (strict), and asserts they are equal. That equality is what turns
 * the denominator from "non-zero" into "complete", and it is what catches a
 * demoted heading, a `*` bullet, or an indented field hiding a wrapped value.
 *
 * Offline: reads `docs/roadmap.md` as text. Invokes prettier only to prove the
 * `.prettierignore` exemption is still in force.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROADMAP = join(REPO_ROOT, 'docs', 'roadmap.md');

/**
 * A field-SHAPED line, permissively: any bullet, any indent. Harness reads
 * only the strict shape — `- **Key:** value` at column 0 with a `-` bullet —
 * so the gap between what this matches and what passes the indent/bullet
 * checks below IS the coverage hole. Matching permissively and then rejecting
 * the wrong shapes is what makes that gap visible; matching strictly would
 * skip them silently, which is how a wrapped value hides.
 */
const FIELD_ANY = /^(\s*)([-*+])\s+\*\*([^*]+):\*\*\s*(.*)$/;
/** The priority enum, fixed by the upstream harness roadmap schema. */
const PRIORITY = /^P[0-3]$/;
/** Any line that starts a heading, well-formed or not. */
const HEADING_ANY = /^#/;
/** A well-formed markdown ATX heading: hashes then whitespace. */
const HEADING = /^#{1,6}\s/;
/** A row heading: `### Some row name`. */
const ROW = /^###\s+(.*)$/;
/** A fenced code block delimiter. */
const FENCE = /^\s*(```|~~~)/;
/** The markdownlint directive the required docs-lint check depends on. */
const MD013_DIRECTIVE = '<!-- markdownlint-disable-file MD013 -->';

type ViolationKind =
  | 'wrapped'
  | 'indented-field'
  | 'bullet-style'
  | 'malformed-heading'
  | 'duplicate-field';

interface Violation {
  /** 1-indexed line number of the offending line. */
  line: number;
  /** The `### ` row it belongs to, or `'(no row)'` before the first. */
  row: string;
  /** The field name involved, or the heading text for a heading violation. */
  field: string;
  kind: ViolationKind;
  /** What harness would silently do with this line. */
  detail: string;
}

interface Row {
  /** The `### ` heading text. */
  name: string;
  /** 1-indexed line of the heading. */
  line: number;
  /** Field name to raw value, for the fields this row declares. */
  fields: Map<string, string>;
}

interface ScanResult {
  /** Fields the STRICT parser inspected — what harness would actually read. */
  fieldsInspected: number;
  /** Lines that LOOK like a field to a human, however bulleted or indented. */
  fieldShapedLines: number;
  violations: Violation[];
  rows: Row[];
}

/**
 * One walk of the file produces both the field scan and the row split.
 *
 * They were two separate functions until review found the failure that split
 * invites: under CRLF the row parser returned 0 rows while the field scanner
 * still counted 316, so the suite failed with "expected 0 to be greater
 * than 0" — a line-ending bug wearing an empty-roadmap costume. One walk, one
 * set of line-ending and fence rules, one story when it breaks.
 *
 * The grammar is enforced positively. A field regex describes what a field
 * looks like, not what a violation looks like, so each rejection rule is
 * spelled out:
 *
 *   - The line after a field must be another field-shaped line, a blank line,
 *     a heading, an HTML comment, or EOF. Anything else is a continuation, and
 *     a continuation is exactly the text harness drops.
 *   - A field-shaped line that is indented or uses a `*`/`+` bullet is NOT
 *     skipped — skipping is how a wrapped value hides. It is reported.
 *   - A heading-shaped line the grammar refuses (`###Foo`, no space) is
 *     reported, because it matches neither the row pattern nor the heading
 *     pattern and would otherwise let one row's fields overwrite another's.
 *   - A field repeated within a row is reported rather than silently
 *     last-wins.
 *
 * Fenced blocks and HTML comment bodies are skipped entirely, so the file can
 * document its own contract with a worked example without tripping the guard.
 */
/** Mutable state threaded through the walk, so each helper does one job. */
interface ScanState extends ScanResult {
  /** The `### ` row currently being filled, if any. */
  current?: Row;
  /** Name of the current row, for violation messages. */
  rowName: string;
  inFence: boolean;
  inComment: boolean;
}

/** The shapes that may legitimately follow a field line. */
const TERMINATORS: ((line: string) => boolean)[] = [
  (line) => line.trim() === '',
  (line) => FIELD_ANY.test(line),
  (line) => HEADING_ANY.test(line),
  (line) => line.startsWith('<!--'),
];

/**
 * A field's value ends at its line. Anything in TERMINATORS legitimately
 * follows it; everything else is a continuation, which is the text harness
 * silently drops. EOF is passed in as an empty line, which is already a
 * terminator — modelling it that way keeps the branch out of the caller.
 */
function isTerminator(line: string): boolean {
  return TERMINATORS.some((matches) => matches(line));
}

/**
 * Fenced blocks and HTML comment bodies are not content: the roadmap documents
 * its own contract in a header comment, and a worked example in a fence must
 * not read as a violation. Returns true when the caller should skip the line.
 */
function skipBlock(line: string, state: ScanState): boolean {
  if (FENCE.test(line)) {
    state.inFence = !state.inFence;
    return true;
  }
  if (state.inFence) return true;

  if (state.inComment) {
    if (line.includes('-->')) state.inComment = false;
    return true;
  }
  if (line.trimStart().startsWith('<!--')) {
    if (!line.includes('-->')) state.inComment = true;
    return true;
  }
  return false;
}

/**
 * Headings open a row, close one, or — when malformed — do neither while
 * looking like they do. `###Foo` matches no heading rule, so without this the
 * next row's fields land on the previous row and overwrite it, which is how a
 * schema-invalid Priority hides. Returns true when the line was a heading.
 */
function handleHeading(line: string, index: number, state: ScanState): boolean {
  const rowMatch = ROW.exec(line);
  if (rowMatch) {
    state.rowName = rowMatch[1].trim();
    state.current = { name: state.rowName, line: index + 1, fields: new Map() };
    state.rows.push(state.current);
    return true;
  }
  if (!HEADING_ANY.test(line)) return false;

  if (!HEADING.test(line)) {
    state.violations.push({
      line: index + 1,
      row: state.rowName,
      field: line.trim(),
      kind: 'malformed-heading',
      detail:
        'heading-shaped line with no space after the hashes; it is neither a ' +
        'row nor a section, so the fields below it would be attributed to ' +
        "the PREVIOUS row and overwrite that row's",
    });
  }
  // Either way it ends the current row: a section heading legitimately does,
  // and a malformed one must not be allowed to merge two rows.
  state.rowName = '(no row)';
  state.current = undefined;
  return true;
}

/**
 * The wrong-shape check. Harness reads a field only at column 0 with a `-`
 * bullet, so an indented or `*`-bulleted field is invisible to it — and any
 * value wrapped beneath one is invisible too. Reported rather than skipped,
 * because skipping is precisely how that hiding place stays open.
 */
function shapeViolation(
  indent: string,
  bullet: string,
  name: string,
  index: number,
  rowName: string,
): Violation | undefined {
  if (indent !== '') {
    return {
      line: index + 1,
      row: rowName,
      field: name,
      kind: 'indented-field',
      detail:
        `indented by ${indent.length} character(s); harness reads fields ` +
        'only at column 0, so this field and any wrap in it are invisible',
    };
  }
  if (bullet !== '-') {
    return {
      line: index + 1,
      row: rowName,
      field: name,
      kind: 'bullet-style',
      detail:
        `bulleted with "${bullet}"; harness reads only "-", so this field ` +
        'and any wrap in it are invisible',
    };
  }
  return undefined;
}

/** Record a field on its row, flagging a second declaration of the same key. */
function recordField(
  name: string,
  value: string,
  index: number,
  state: ScanState,
): void {
  const row = state.current;
  if (!row) return;

  if (row.fields.has(name)) {
    state.violations.push({
      line: index + 1,
      row: state.rowName,
      field: name,
      kind: 'duplicate-field',
      detail:
        'declared twice in this row; the parsers disagree about which wins, ' +
        'so a contradictory value can read as valid',
    });
  }
  row.fields.set(name, value.trim());
}

/** Count a field-shaped line, check its shape, then check for a wrap. */
function handleField(
  line: string,
  index: number,
  next: string,
  state: ScanState,
): void {
  const match = FIELD_ANY.exec(line);
  if (!match) return;

  const [, indent, bullet, name, value] = match;
  state.fieldShapedLines++;

  const wrongShape = shapeViolation(indent, bullet, name, index, state.rowName);
  if (wrongShape) {
    state.violations.push(wrongShape);
    return;
  }

  // From here the line is a field harness would genuinely read.
  state.fieldsInspected++;
  recordField(name, value, index, state);

  if (!isTerminator(next)) {
    state.violations.push({
      line: index + 2,
      row: state.rowName,
      field: name,
      kind: 'wrapped',
      detail: `harness discards: "${truncate(next.trim(), 60)}"`,
    });
  }
}

function scanRoadmap(text: string): ScanResult {
  // Split on both line endings: a CRLF checkout is a checkout, not a defect,
  // and `.` never matches `\r`, so a bare `\n` split silently breaks every
  // value-capturing regex above.
  const lines = text.split(/\r?\n/);
  const state: ScanState = {
    fieldsInspected: 0,
    fieldShapedLines: 0,
    violations: [],
    rows: [],
    rowName: '(no row)',
    inFence: false,
    inComment: false,
  };

  for (let i = 0; i < lines.length; i++) {
    if (skipBlock(lines[i], state)) continue;
    if (handleHeading(lines[i], i, state)) continue;
    handleField(lines[i], i, lines[i + 1] ?? '', state);
  }

  const { fieldsInspected, fieldShapedLines, violations, rows } = state;
  return { fieldsInspected, fieldShapedLines, violations, rows };
}

/** Ellipsis only when text was actually cut — a `…` on a short string lies. */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Render violations naming the row, the field, and the consequence. */
function describeViolations(v: Violation[]): string {
  return v
    .map(
      (x) =>
        `  docs/roadmap.md:${x.line} — row "${x.row}", field "${x.field}" ` +
        `[${x.kind}]: ${x.detail}`,
    )
    .join('\n');
}

const CLEAN = [
  '## Section',
  '',
  '### A row',
  '',
  '- **Status:** backlog',
  '- **Priority:** P1',
  '- **Summary:** one physical line, however long it happens to run, because that is the contract.',
  '- **External-ID:** github:bop-clocktower/canary#1',
  '',
  '### Another row',
  '',
  '- **Priority:** P3',
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
      const result = scanRoadmap(CLEAN);

      expect(result.violations).toEqual([]);
      expect(result.fieldsInspected).toBe(5);
      expect(result.fieldShapedLines).toBe(5);
    });

    it('names the row, the field, and the text harness would discard', () => {
      const result = scanRoadmap(WRAPPED);

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]).toMatchObject({
        line: 5,
        row: 'A row',
        field: 'Summary',
        kind: 'wrapped',
      });
      expect(result.violations[0].detail).toContain('invisible to harness');
    });

    it.each([
      ['another field', '- **Status:** x\n\n- **Other:** y'],
      ['a section heading', '- **Status:** x\n## Next section'],
      ['an HTML comment', '- **Status:** x\n<!-- note -->'],
      ['EOF', '- **Status:** x'],
    ])(
      'treats %s after a field as a terminator, not a wrap',
      (_label, text) => {
        expect(scanRoadmap(text).violations).toEqual([]);
      },
    );

    it('reports a zero denominator rather than a clean result', () => {
      // The failure this whole file guards against: a parser that stops
      // matching looks identical to a spotless file unless the count is
      // asserted. Zero fields inspected is an abstention, not a pass.
      const result = scanRoadmap('# Roadmap\n\nNo fields here at all.\n');

      expect(result.violations).toEqual([]);
      expect(result.fieldsInspected).toBe(0);
      expect(result.fieldShapedLines).toBe(0);
    });
  });

  describe('the coverage hole a non-zero denominator cannot see', () => {
    // Each of these once passed every assertion in this file while a
    // schema-invalid value sat in the roadmap. They are the reason the scan
    // compares inspected against field-shaped instead of just asserting
    // "more than zero".

    it('reports a demoted row heading instead of dropping the row', () => {
      const text = [
        '### Real row',
        '- **Priority:** P0',
        '',
        '#### Demoted row',
        '- **Priority:** WHATEVER',
      ].join('\n');

      const result = scanRoadmap(text);

      // The demoted row is not a row, so its bad Priority must not simply
      // vanish — the field/row cross-check below is what catches it.
      const attached = result.rows.reduce((n, r) => n + r.fields.size, 0);
      expect(result.fieldsInspected).toBe(2);
      expect(attached).toBe(1);
      expect(result.fieldsInspected).not.toBe(attached);
    });

    it('reports a heading with no space after the hashes', () => {
      const text = [
        '### First row',
        '- **Priority:** P9',
        '',
        '###Second row',
        '- **Status:** backlog',
      ].join('\n');

      const result = scanRoadmap(text);

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]).toMatchObject({
        kind: 'malformed-heading',
        line: 4,
      });
      // Critically, the second row's fields must NOT land on the first row —
      // that overwrite is what used to mask the P9 above.
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].fields.get('Priority')).toBe('P9');
      expect(result.rows[0].fields.has('Status')).toBe(false);
    });

    it.each([
      ['a * bullet', '* **Summary:** wrapped value continues', 'bullet-style'],
      [
        'an indent',
        '  - **Summary:** wrapped value continues',
        'indented-field',
      ],
    ])('reports %s rather than skipping the field', (_label, field, kind) => {
      const text = ['### A row', field, '  invisible continuation line'].join(
        '\n',
      );

      const result = scanRoadmap(text);

      // The old scanner skipped these silently: no count, no check, and the
      // wrapped value below them went unseen.
      expect(result.fieldShapedLines).toBe(1);
      expect(result.fieldsInspected).toBe(0);
      expect(result.violations[0]).toMatchObject({ kind });
    });

    it('reports a field declared twice in one row', () => {
      const text = [
        '### A row',
        '- **Priority:** nonsense',
        '- **Priority:** P1',
      ].join('\n');

      const result = scanRoadmap(text);

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]).toMatchObject({
        kind: 'duplicate-field',
        field: 'Priority',
      });
    });
  });

  describe('inputs that must not trip the guard', () => {
    it('reads a CRLF file exactly as it reads an LF one', () => {
      // `.` never matches `\r`, so a bare '\n' split made every row parse
      // fail and reported it as "the roadmap has no rows".
      const lf = scanRoadmap(CLEAN);
      const crlf = scanRoadmap(CLEAN.replace(/\n/g, '\r\n'));

      expect(crlf.violations).toEqual([]);
      expect(crlf.rows.length).toBe(lf.rows.length);
      expect(crlf.fieldsInspected).toBe(lf.fieldsInspected);
    });

    it('ignores fields and headings inside a fenced code block', () => {
      const text = [
        '### A row',
        '- **Priority:** P1',
        '',
        '```markdown',
        '### Example row',
        '- **Priority:** not-a-real-value',
        '```',
      ].join('\n');

      const result = scanRoadmap(text);

      expect(result.rows).toHaveLength(1);
      expect(result.fieldsInspected).toBe(1);
      expect(result.violations).toEqual([]);
    });

    it('ignores field-shaped lines inside an HTML comment body', () => {
      // The file documents its own contract in a header comment; a worked
      // example in there must not read as a violation.
      const text = [
        '<!-- Machine-managed. Example of the contract:',
        '- **Summary:** one physical line',
        '-->',
        '',
        '### A row',
        '- **Priority:** P2',
      ].join('\n');

      const result = scanRoadmap(text);

      expect(result.violations).toEqual([]);
      expect(result.fieldsInspected).toBe(1);
    });
  });

  describe('the Priority enum', () => {
    // P0-P3 is fixed upstream and hard-fails on read, so an out-of-enum value
    // is not a style question — it breaks `harness roadmap` outright. These
    // fixtures exist because the enum check previously ran only against the
    // real file, where it passed: rotting PRIORITY to /^P\d$/ or dropping its
    // anchors left every test in this file green.
    it.each([
      ['P4', 'above the enum'],
      ['p1', 'lowercase'],
      ['P1 (highest)', 'annotated'],
      ['—', 'the em-dash placeholder'],
      ['', 'empty'],
    ])('rejects %s (%s)', (value) => {
      expect(PRIORITY.test(value)).toBe(false);
    });

    it.each(['P0', 'P1', 'P2', 'P3'])('accepts %s', (value) => {
      expect(PRIORITY.test(value)).toBe(true);
    });

    it('reports the row and the offending value, not just a count', () => {
      const text = [
        '### Good row',
        '- **Priority:** P1',
        '',
        '### Bad row',
        '- **Priority:** P9',
      ].join('\n');

      const rows = scanRoadmap(text).rows;
      const bad = rows.filter(
        (r) => !PRIORITY.test(r.fields.get('Priority') ?? ''),
      );

      expect(bad).toHaveLength(1);
      expect(bad[0].name).toBe('Bad row');
      expect(bad[0].fields.get('Priority')).toBe('P9');
    });
  });

  describe('docs/roadmap.md', () => {
    // Read inside the tests, not in the describe body: a missing or unreadable
    // roadmap should be a named failing test, not a suite-collection crash.
    const scan = (): ScanResult => scanRoadmap(readFileSync(ROADMAP, 'utf8'));

    it('inspects a non-zero number of fields', () => {
      // Denominator first: without this, every assertion below passes
      // vacuously the day the field syntax changes.
      const result = scan();

      expect(
        result.fieldsInspected,
        'zero fields inspected — an abstention, not a pass',
      ).toBeGreaterThan(0);
    });

    it('inspects EVERY field-shaped line, not merely some of them', () => {
      // The completeness half of the denominator. A non-zero count proves the
      // scanner ran; only this equality proves it ran over everything. The
      // gap between the two counts is exactly where a demoted heading, a `*`
      // bullet, or an indented field hides a wrapped value.
      const result = scan();

      expect(
        result.fieldsInspected,
        `${result.fieldShapedLines - result.fieldsInspected} field-shaped ` +
          `line(s) were NOT inspected (${result.fieldsInspected} of ` +
          `${result.fieldShapedLines}) — harness cannot see them`,
      ).toBe(result.fieldShapedLines);
    });

    it('attaches every inspected field to a row', () => {
      // Catches the inverse hole: fields that parse fine but belong to no
      // row, so the per-row Priority assertion never examines them.
      const result = scan();
      const attached = result.rows.reduce((n, r) => n + r.fields.size, 0);

      expect(
        attached,
        `${result.fieldsInspected - attached} field(s) sit outside any "### " ` +
          'row — a row heading probably changed level',
      ).toBe(result.fieldsInspected);
    });

    it('has no field value wrapped across lines', () => {
      const result = scan();

      expect(
        result.violations,
        `${result.violations.length} contract violation(s) — harness ` +
          `silently mis-reads each:\n${describeViolations(result.violations)}`,
      ).toEqual([]);
    });

    it('parses a non-zero number of rows', () => {
      const result = scan();

      expect(result.rows.length).toBeGreaterThan(0);
    });

    it('gives every row a Priority in the schema-s enum', () => {
      const result = scan();
      const bad = result.rows.filter(
        (r) => !PRIORITY.test(r.fields.get('Priority') ?? ''),
      );

      expect(
        bad.map(
          (r) =>
            `docs/roadmap.md:${r.line} "${r.name}" -> ` +
            `${JSON.stringify(r.fields.get('Priority') ?? '(absent)')}`,
        ),
        `${bad.length} of ${result.rows.length} row(s) lack a valid ` +
          'Priority (P0-P3)',
      ).toEqual([]);
    });
  });

  describe('the guards the file depends on', () => {
    it('is still exempt from prettier', () => {
      // The behavioural form, not a grep of `.prettierignore`: this also
      // catches a prettier-config change that re-governs the file by another
      // route. Run from the repo root — prettier resolves `.prettierignore`
      // relative to CWD, so from `ts/` the exemption does not apply.
      const result = spawnSync(
        'npx',
        ['prettier', '--check', 'docs/roadmap.md'],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );

      expect(
        result.status,
        'prettier would rewrap docs/roadmap.md — the .prettierignore entry ' +
          `is missing or no longer matches:\n${result.stderr ?? ''}`,
      ).toBe(0);
    });

    it('keeps the markdownlint directive a required check depends on', () => {
      // docs-lint.yml globs **/*.md with no path filter and is required in
      // .github/required-checks.json. Without this directive the file reports
      // 50 MD013 errors and blocks every merge. `harness roadmap promote` is
      // known to strip it (canary#273), so it is asserted here rather than
      // left to the opt-in local pre-commit hook.
      const text = readFileSync(ROADMAP, 'utf8');

      expect(
        text.includes(MD013_DIRECTIVE),
        `docs/roadmap.md lost "${MD013_DIRECTIVE}" — the required ` +
          'markdownlint check will fail on its long single-line fields',
      ).toBe(true);
    });
  });
});
