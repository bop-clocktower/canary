/**
 * batwoman's report, rendered through canary's persona registry (spec D7).
 *
 * Two rules bind harder than anything else here, and both are asserted in
 * `ts/test/batwoman-render-invariants.test.ts` across all three registers
 * rather than once against the default:
 *
 * **There is no success-only path.** Every run ends with one column per status,
 * including the two that mean batwoman could not decide. A detector that
 * covered two of seven changed files and printed a clean token would be a pass
 * over a denominator of two presented as a pass over seven -- the exact defect
 * batwoman exists to catch, committed by batwoman (spec D5).
 *
 * **Every row keeps its sentence.** `ExerciseVerdict.explanation` renders in
 * every register, terse included. What the terse register drops is the material
 * gated by the persona's `reasoning` flag -- the evidence line and the
 * next-step guidance -- not the observation-and-cause sentence itself, which is
 * the difference between a verdict and a status code.
 */

import type { ResolvedPersona } from '../../core/persona.js';
import {
  EXERCISE_STATUSES,
  tallyVerdicts,
  type ClosureHeader,
  type ExerciseStatus,
  type ExerciseVerdict,
} from './verdict.js';

/** Column labels, in `EXERCISE_STATUSES` order. */
const SUMMARY_LABELS: Readonly<Record<ExerciseStatus, string>> = {
  exercised: 'exercised',
  'not-exercised': 'not exercised',
  abstain: 'abstained',
  'no-probe': 'no probe',
  'not-applicable': 'n/a',
};

/**
 * The one line every run prints.
 *
 * The changed-file total leads so the denominator is read before any count;
 * the render suite asserts the columns sum to it.
 */
export function summaryLine(verdicts: readonly ExerciseVerdict[]): string {
  const { changed, byStatus } = tallyVerdicts(verdicts);
  const columns = EXERCISE_STATUSES.map(
    (status) => `${byStatus[status]} ${SUMMARY_LABELS[status]}`,
  );
  return [`${changed} changed`, ...columns].join(' · ');
}

/**
 * Greedy word wrap with a fixed indent. A too-long word gets its own line.
 *
 * **Explanations are single-paragraph prose.** `split(/\s+/)` normalises all
 * internal whitespace, so a newline becomes a space and a run of spaces becomes
 * one. That is a decision, not an accident, and it is recorded here because
 * Phase 2 probes will compose explanations out of evidence and the temptation
 * to embed a command, a YAML fragment or an indented log line is real. A verdict
 * sentence is a sentence: the thing a probe wants to quote belongs in
 * `evidence`, which {@link fitLine} wraps without reflowing it, or in a future
 * field that declares itself preformatted. Reflowing a YAML fragment silently
 * would be worse than refusing it, so if that need arrives, add the field --
 * do not relax this.
 */
export function wrap(text: string, width: number, indent: string): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter((w) => w !== '')) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (indent.length + candidate.length <= width || current === '') {
      current = candidate;
    } else {
      lines.push(indent + current);
      current = word;
    }
  }
  if (current !== '') lines.push(indent + current);
  return lines;
}

/**
 * Fit an already-assembled line to the width, breaking it only if it overflows.
 *
 * `wrap` cannot do this job: a file path is a single whitespace-free token, so
 * `wrap` would faithfully put all 86 columns of it on one line. This breaks at a
 * space when there is one inside the remaining room and chops the token when
 * there is not, which is the only way a path fits at all.
 *
 * A line that already fits is returned untouched, so every short row keeps its
 * exact spacing -- including the two spaces the terse register puts between a
 * path and its status.
 */
export function fitLine(
  line: string,
  width: number,
  continuation: string,
): string[] {
  if (line.length <= width) return [line];
  const lines: string[] = [];
  let rest = line;
  let indent = '';
  while (indent.length + rest.length > width && rest !== '') {
    const room = width - indent.length;
    const space = rest.lastIndexOf(' ', room);
    // A space break is only taken when it fills at least half the line. Every
    // row here starts with a marker -- two spaces of indent, `  - `, `    1. `
    // -- and the last space *within the room* of a long path is the one right
    // after that marker. Breaking there emitted `  -` and `    1.` alone on a
    // line, and for a plain indented path an empty one. A path with no spaces
    // in it has to be chopped somewhere; chopping it at the width reads better
    // than orphaning its bullet.
    const cut = space * 2 >= room ? space : room;
    lines.push((indent + rest.slice(0, cut)).trimEnd());
    rest = rest.slice(cut).trimStart();
    indent = continuation;
  }
  if (rest !== '') lines.push(indent + rest);
  return lines;
}

/** Everything the renderer needs. Probes never see this. */
export interface RenderOptions {
  readonly header: ClosureHeader;
  readonly repo: string;
  readonly verdicts: readonly ExerciseVerdict[];
  readonly persona: ResolvedPersona;
}

/** `2026-08-22 17:34 UTC`, stable across the runner's timezone. */
function stamp(when: Date): string {
  return `${when.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** The report's column limit. Header and body wrap to the same width. */
const WIDTH = 78;

/**
 * One `  Label     value` header row, wrapped with a hanging indent.
 *
 * The header wraps for the same reason the body does, and it is the amendment
 * this module needed most: both values it carries are free text of unbounded
 * length. A commit subject is whatever the author typed, and
 * `ResolvedPersona.reason` is a composed sentence -- an unknown register
 * produces one naming every candidate. Emitted unwrapped, those two lines were
 * 83 and 199 columns wide against a 78-column report, and only short fixtures
 * kept that from being visible.
 */
function labelled(label: string, value: string): string[] {
  const prefix = `  ${label.padEnd(9)}  `;
  const lines = wrap(value, WIDTH, ' '.repeat(prefix.length));
  const [first, ...rest] = lines;
  // An empty value used to emit `  Closed by` and nothing else -- a label
  // dangling over blank space, which is the same silent-empty shape the verdict
  // model now forbids outright. Naming the gap keeps it countable by eye.
  if (first === undefined) return [`${prefix}(none recorded)`];
  // The first line swaps the blank indent for the label; the rest keep it, so
  // continuations align under the value rather than under the label.
  return [prefix + first.slice(prefix.length), ...rest];
}

function headerLines(options: RenderOptions): string[] {
  const { header, repo, persona } = options;
  return [
    `canary batwoman — ${repo}#${header.issue}`,
    '',
    ...labelled('Closed by', `${header.mergeSha}  ${header.mergeSubject}`),
    ...labelled('Merged', stamp(header.mergedAt)),
    // Printed so a reader who got terse output when they wanted guided output
    // can tell a short report from a truncated one (spec criterion 9).
    ...labelled(
      'Register',
      `${persona.persona.id} (${persona.persona.label}) — ` +
        `${persona.source}: ${persona.reason}`,
    ),
    '',
  ];
}

/** Section headings, in report order: the findings first. */
const SECTIONS: ReadonlyArray<readonly [ExerciseStatus, string]> = [
  ['not-exercised', 'NOT EXERCISED'],
  ['abstain', 'ABSTAINED'],
  ['no-probe', 'NO PROBE'],
  ['exercised', 'EXERCISED'],
  ['not-applicable', 'NOT APPLICABLE'],
];

/**
 * A section heading.
 *
 * The first finding section states its denominator inline; the rest are counted
 * against the same total one line below, in the summary that always prints.
 */
function heading(
  label: string,
  status: ExerciseStatus,
  rows: number,
  total: number,
): string {
  const files = (count: number) => (count === 1 ? 'file' : 'files');
  return status === 'not-exercised'
    ? `  ${label} — ${rows} of ${total} changed ${files(total)}`
    : `  ${label} — ${rows} ${files(rows)}`;
}

function briefRows(
  verdicts: readonly ExerciseVerdict[],
  reasoning: boolean,
): string[] {
  const lines: string[] = [];
  for (const verdict of verdicts) {
    lines.push(...fitLine(`    ${verdict.file}`, WIDTH, '      '));
    lines.push(...wrap(verdict.explanation, WIDTH, '      '));
    if (reasoning && verdict.evidence !== undefined) {
      lines.push(
        ...fitLine(`      Read: ${verdict.evidence}`, WIDTH, '        '),
      );
    }
    lines.push('');
  }
  return lines;
}

/**
 * What a reader can actually do about each status.
 *
 * `exercised` and `not-applicable` are absent on purpose: there is nothing to
 * ask for, and inventing a step for them would be the guided register's version
 * of a success token.
 */
const NEXT_STEPS: Partial<Record<ExerciseStatus, string>> = {
  'not-exercised':
    'Run the path this file belongs to, then re-run canary batwoman to ' +
    'confirm it moved.',
  abstain:
    'Check the evidence source named above, then re-run canary batwoman so ' +
    'this file gets a verdict instead of a gap.',
  'no-probe':
    'Add an ExerciseProbe for this artifact type so the gap stops being ' +
    'uncountable, or confirm by hand that the file ran.',
};

function guidedRows(
  verdicts: readonly ExerciseVerdict[],
  status: ExerciseStatus,
): string[] {
  const lines: string[] = [];
  verdicts.forEach((verdict, index) => {
    lines.push(
      ...fitLine(`    ${index + 1}. ${verdict.file}`, WIDTH, '       '),
    );
    lines.push(...wrap(verdict.explanation, WIDTH, '       '));
    if (verdict.evidence !== undefined) {
      lines.push(
        ...fitLine(`       Read: ${verdict.evidence}`, WIDTH, '         '),
      );
    }
    const step = NEXT_STEPS[status];
    if (step !== undefined) {
      lines.push(...wrap(`Next: ${step}`, WIDTH, '       '));
    }
    lines.push('');
  });
  return lines;
}

function terseRows(verdicts: readonly ExerciseVerdict[]): string[] {
  return verdicts.flatMap((verdict) => [
    ...fitLine(`  - ${verdict.file}  ${verdict.status}`, WIDTH, '    '),
    ...wrap(verdict.explanation, WIDTH, '    '),
  ]);
}

function bodyLines(options: RenderOptions): string[] {
  const { verdicts, persona } = options;
  const lines: string[] = [];
  for (const [status, label] of SECTIONS) {
    const rows = verdicts.filter((verdict) => verdict.status === status);
    // An empty section is omitted, not printed as a zero: the counts that
    // matter are in the summary line, which prints all five unconditionally.
    if (rows.length === 0) continue;
    if (persona.persona.depth === 'terse') {
      lines.push(...terseRows(rows));
      continue;
    }
    if (persona.persona.depth === 'guided') {
      lines.push(heading(label, status, rows.length, verdicts.length));
      lines.push(...guidedRows(rows, status));
      continue;
    }
    lines.push(heading(label, status, rows.length, verdicts.length));
    lines.push(...briefRows(rows, persona.persona.reasoning));
  }
  return lines;
}

/** The whole report, as one string whose last content line is the summary. */
export function renderReport(options: RenderOptions): string {
  return [
    ...headerLines(options),
    ...bodyLines(options),
    '  ' + '─'.repeat(62),
    '  ' + summaryLine(options.verdicts),
    '',
  ].join('\n');
}
