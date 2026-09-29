// render -- pure: an assembled brief in, markdown or JSON out.
//
// Split from brief.mjs so each stays under the perf file-length rule. Copy is
// guarded by the SC9 test: no verdict language anywhere in the output, the
// banner included -- there is no carve-out.

import { THIN_OBSERVATIONS } from './brief.mjs';

export const BANNER = 'Evidence brief — hypotheses and evidence, no call made';

const LABELS = {
  'test-defect': 'Defect in the test',
  'product-defect': 'Defect in the system under test',
  environment: 'Environment or infrastructure',
};

const bullet = (r) => `- \`${r.signal}\` (${r.source}): ${r.detail}`;
const bullets = (rows) =>
  rows.length ? rows.map(bullet) : ['- none recorded'];

function denominatorLine({ observations, failures, runs_in_store }) {
  return `observations: ${observations} · failures: ${failures} · runs in store: ${runs_in_store}`;
}

function headerLines(brief) {
  const lines = [
    `# canary-question: ${brief.test}`,
    '',
    `> **${BANNER}.** Each hypothesis lists what the stored evidence says for and against it, in a fixed order. Advisory only.`,
    '',
    `**Fidelity:** ${brief.fidelity} · **Denominator:** ${denominatorLine(brief.denominator)}`,
  ];
  if (brief.fidelity === 'thin') {
    lines.push(
      '',
      `> **THIN EVIDENCE:** ${brief.denominator.observations} of ${THIN_OBSERVATIONS} observations. One run is not the whole story.`,
    );
  }
  if (brief.abstained) {
    lines.push('', `> **ABSTAINED:** ${brief.abstained.reason}.`);
  }
  return lines;
}

function targetLines({ target }) {
  if (!target.run_id) return [];
  const pass = target.last_pass_commit_sha ?? 'none recorded';
  return [
    '',
    `**Target failure:** run ${target.run_id} at ${target.commit_sha ?? 'an unrecorded commit'} (${target.timestamp ?? 'no timestamp'}), status ${target.status}; last pass: ${pass}`,
  ];
}

function hypothesisLines(brief) {
  if (brief.abstained) return [];
  return brief.hypotheses.flatMap((h) => [
    '',
    `## ${LABELS[h.id]}`,
    '',
    '**For**',
    '',
    ...bullets(h.for),
    '',
    '**Against**',
    '',
    ...bullets(h.against),
  ]);
}

function neutralLines({ neutral }) {
  if (!neutral.length) return [];
  return ['', '## Recorded, does not discriminate', '', ...neutral.map(bullet)];
}

function emptyNotChecked(brief) {
  return brief.abstained
    ? '- nothing read: brief abstained'
    : '- nothing; every source was read';
}

function notCheckedLines(brief) {
  const rows = brief.not_checked;
  const body = rows.length
    ? rows.map((n) => `- ${n.source}: ${n.reason}`)
    : [emptyNotChecked(brief)];
  return ['', '## Not checked', '', ...body];
}

function disambiguateLines({ disambiguate }) {
  return [
    '',
    '## What would disambiguate',
    '',
    ...disambiguate.map((s, i) => `${i + 1}. ${s}`),
  ];
}

export function renderMarkdown(brief) {
  return [
    ...headerLines(brief),
    ...targetLines(brief),
    ...hypothesisLines(brief),
    ...neutralLines(brief),
    ...notCheckedLines(brief),
    ...disambiguateLines(brief),
  ].join('\n');
}

export function renderJson(brief) {
  return JSON.stringify(brief, null, 2);
}
