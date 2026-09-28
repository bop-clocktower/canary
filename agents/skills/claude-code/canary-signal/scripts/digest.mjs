// digest -- render a tally as markdown plus a chat-ready block (#609).
//
// Pure. Every number is printed beside the count it was measured over; a
// metric whose count was zero prints ABSTAINED and why, never 0. The copy
// says what was observed ("failures caught on branches other than main"),
// never what we would like to be true ("bugs prevented") -- a failing test
// may be a test bug, not a product bug (spec D7).
//
// The chat block always leads with the sample line: it is the one line a
// reader of a forwarded message must not lose.

import { THIN_SAMPLE_RUNS } from './tally.mjs';

const ABSTAINED_LINE =
  'ABSTAINED: no runs recorded in the window — this digest measured nothing, which is not the same as a quiet week.';

/** Pinned by test; chat clients fold anything longer. */
export const CHAT_MAX_LINES = 8;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const day = (d) => d.toISOString().slice(0, 10);

function sampleLine(t) {
  const { runs, suites, days } = t.sample;
  const span = `${t.window.since.toISOString()} → ${t.window.until.toISOString()}`;
  return `${plural(runs, 'run')} across ${plural(suites, 'suite')} on ${plural(days, 'day')}, ${span}`;
}

function metricLine(label, m, describe) {
  const body = m.abstained ? `ABSTAINED — ${m.reason}` : describe(m);
  return `- ${label}: ${body}`;
}

const failures = (m) =>
  `${plural(m.value, 'distinct failing test')} across ${plural(m.denominator, 'run')}`;

const pairs = (entries) =>
  entries.map(([k, n]) => `${k} ${n}`).join(', ') || 'none';

function quarantineText(m) {
  const undated = m.undated > 0 ? `; ${m.undated} undated excluded` : '';
  return `${plural(m.value, 'ledger row')} dated in the window of ${m.denominator} (kind: ${pairs(m.byKind)}; cause: ${pairs(m.byCause)})${undated}`;
}

function caughtLines(t) {
  return [
    metricLine(
      'Tests executed',
      t.tests,
      (m) => `${m.value} across ${plural(m.denominator, 'run')}`,
    ),
    metricLine(
      `Failures caught on branches other than ${t.branch}`,
      t.preMerge,
      failures,
    ),
    metricLine(`Failures that reached ${t.branch}`, t.reached, failures),
    metricLine(
      'Flaky tests surfaced',
      t.flaky,
      (m) =>
        `${plural(m.value, 'distinct test')} across ${plural(m.denominator, 'flaky-capable run')}`,
    ),
    metricLine('Quarantine trail', t.quarantine, quarantineText),
  ];
}

function sampleNotes(t) {
  const notes = [];
  if (t.undatedRuns > 0) {
    notes.push(
      `- ${plural(t.undatedRuns, 'undated run')} excluded (no parseable timestamp).`,
    );
  }
  if (t.unbranched > 0) {
    notes.push(
      `- ${plural(t.unbranched, 'run')} with no branch counted in neither branch line.`,
    );
  }
  return notes;
}

function bodyLines(t) {
  if (t.state === 'abstained') return [`**${ABSTAINED_LINE}**`];
  const banner =
    t.state === 'thin'
      ? [
          `> **THIN SAMPLE:** ${plural(t.sample.runs, 'run')} in the window. Below ${THIN_SAMPLE_RUNS} runs, one run is the whole story — read every number below as anecdote, not trend.`,
          '',
        ]
      : [];
  return [...banner, '## What testing caught', '', ...caughtLines(t)];
}

function chatLines(t) {
  const head = `canary-signal digest — ${sampleLine(t)}`;
  if (t.state === 'abstained') return [head, ABSTAINED_LINE];
  const thin = t.state === 'thin' ? ['THIN SAMPLE — anecdote, not trend.'] : [];
  const body = caughtLines(t).map((line) => line.slice(2));
  return [
    head,
    ...thin,
    ...body,
    `Dark sources: ${t.dark.length} (see the digest)`,
  ];
}

/** @returns {{markdown: string, chatBlock: string}} */
export function renderDigest(t) {
  const chatBlock = chatLines(t).join('\n');
  const markdown = [
    `# QA signal: ${day(t.window.since)} → ${day(t.window.until)}`,
    '',
    `**Sample:** ${sampleLine(t)}`,
    ...sampleNotes(t),
    '',
    ...bodyLines(t),
    '',
    '## Dark sources',
    '',
    ...t.dark.map((d) => `- ${d}`),
    '',
    '## Chat-ready',
    '',
    '```text',
    chatBlock,
    '```',
    '',
  ].join('\n');
  return { markdown, chatBlock };
}
