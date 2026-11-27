// render -- Markdown for an assembled report (spec D9, D13). Pure.
//
// Every value from the report passes through `md` (the report object holds
// `plain` values already; `md` re-cleans and escapes). Numbers are formatted
// here and never escaped. Sections print in a fixed order, and a section that
// was not assessed is printed with its reason, never left out.

import { md } from './text.mjs';

export const BANNER =
  'Report only: what overlaps and what grew. Every decision about a test ' +
  'stays with you.';

// U+26A0 / U+2014 as escapes so the source stays ASCII (savant's convention).
export const ABSTAINED_LINE =
  '\u{26A0} Abstained \u{2014} verified zero items; this is not a pass.';

/** Markdown lists stop here; --json always carries every entry. */
export const MAX_ROWS = 50;

const DOT = ' \u{00B7} ';

function statusLine(section, parts) {
  if (section.status === 'not_assessed') {
    return `**Status:** not assessed: ${md(section.reason, 400)}`;
  }
  return `**Status:** assessed${DOT}${parts.join(DOT)}`;
}

function capped(rows, render) {
  const lines = rows.slice(0, MAX_ROWS).flatMap(render);
  if (rows.length > MAX_ROWS) {
    lines.push(`- ${rows.length - MAX_ROWS} more in --json`);
  }
  return lines;
}

const listOr = (rows, empty) => (rows.length ? rows : [`- ${empty}`]);

function notReadLines(s) {
  if (!s.not_read?.length) return [];
  return [
    '',
    `Not read (${s.not_read.length}):`,
    '',
    ...capped(s.not_read, (u) => [`- ${md(u.file)}: ${md(u.reason)}`]),
  ];
}

const fixtureRow = (g) => [
  `- ${g.kind}, ${g.body_lines} body lines, first line: ${md(g.first_line)}` +
    ` \u{2014} ${g.locations.length} locations`,
  ...g.locations.map((l) => `  - ${md(l.file)}:${l.line} (${md(l.name)})`),
];

function fixtureLines(s) {
  const d = s.denominator;
  const lines = [
    '## Duplicated fixtures',
    '',
    statusLine(s, [
      `files scanned: ${d.files_scanned}`,
      `setup blocks: ${d.setup_blocks}`,
      `groups: ${s.groups?.length}`,
    ]),
  ];
  if (s.status === 'assessed') {
    lines.push(
      '',
      ...listOr(capped(s.groups, fixtureRow), 'no setup body repeats'),
    );
  }
  return [...lines, ...notReadLines(s)];
}

const overlapRow = (g) => [
  `- ${g.tests.length} tests cover the same ${g.line_count} lines:`,
  ...g.tests.map((t) => `  - ${md(t)}`),
  '  - lines: ' +
    g.shared_lines.map((l) => `${md(l.file)} ${md(l.ranges, 400)}`).join('; '),
  `  - note: ${g.caveat}`,
];

function coverageLines(s) {
  const lines = [
    '## Overlapping coverage',
    '',
    statusLine(s, [
      `tests with coverage: ${s.denominator.tests_with_coverage}`,
      `groups: ${s.groups?.length}`,
    ]),
  ];
  if (s.status !== 'assessed') return lines;
  return [
    ...lines,
    '',
    `> ${s.caveat}`,
    '',
    ...listOr(
      capped(s.groups, overlapRow),
      'no two tests share an identical line set',
    ),
  ];
}

const percent = (share) => `${Math.round(share * 1000) / 10}%`;

const timeRow = (w) => [
  `| ${md(w.file)} | ${w.median_ms} | ${percent(w.share)} |`,
];

function grewAt({ run_id, commit_sha, timestamp }) {
  const run = run_id === null ? 'an unrecorded run' : `run ${md(run_id)}`;
  const sha = commit_sha === null ? 'an unrecorded commit' : md(commit_sha);
  const when = timestamp === null ? 'no timestamp' : md(timestamp);
  return `${run} at ${sha} (${when})`;
}

const creepRow = (c) => {
  const what =
    c.scope === 'file'
      ? `file ${md(c.file)}`
      : `test ${md(c.file)} > ${md(c.test)}`;
  return [
    `- ${what}: ${c.before_median_ms} ms to ${c.after_median_ms} ms` +
      ` (+${c.gap_ms} ms, ${c.observations} runs), from ${grewAt(c.grew_at)}`,
  ];
};

function runtimeBody(s) {
  const t = s.thresholds;
  return [
    '',
    `Listed when a series has at least ${t.min_observations} runs, its median ` +
      `after the step is at least ${t.min_ratio}x the median before, and the ` +
      `step is at least ${t.min_gap_ms} ms. These are listing rules only.`,
    '',
    '### Where the time went (median of each file over its last 5 runs)',
    '',
    '| File | Median ms | Share |',
    '| ---- | --------- | ----- |',
    ...capped(s.where_time_went, timeRow),
    '',
    '### When it grew',
    '',
    ...listOr(capped(s.creep, creepRow), 'no series grew by the rules above'),
  ];
}

function runtimeLines(s) {
  const d = s.denominator;
  const head = [
    '## Runtime creep over history',
    '',
    statusLine(s, [
      `runs: ${d.runs}`,
      `timed tests: ${d.timed_tests}`,
      `tests with enough runs: ${d.series_long_enough}`,
    ]),
  ];
  return s.status === 'assessed' ? [...head, ...runtimeBody(s)] : head;
}

/**
 * @param {ReturnType<typeof import('./report.mjs').assembleReport>} report
 */
export function renderMarkdown(report) {
  const { fixtures, coverage, runtime } = report.sections;
  const lines = ['# canary-ivy: suite overgrowth report', '', `> ${BANNER}`];
  if (report.abstained) lines.push('', ABSTAINED_LINE);
  for (const section of [
    fixtureLines(fixtures),
    coverageLines(coverage),
    runtimeLines(runtime),
  ]) {
    lines.push('', ...section);
  }
  return lines.join('\n');
}
