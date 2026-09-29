// brief -- pure: gathered evidence in, the evidence brief out.
//
// The brief is never a verdict (D1). Three hypotheses, always in HYPOTHESES
// order, each with the rows that bear for and against it. Nothing counts rows
// per hypothesis, sorts by evidence, or picks a side. Fidelity is derived from
// what was actually read (D5), and abstention prints no evidence at all (D6).

import {
  HYPOTHESES,
  categoryRows,
  coFailureRows,
  historySignals,
  resolveCategory,
} from './signals.mjs';
import { findingsEvidence } from './findings.mjs';

/** The smallest sample where one run is not the whole story (signal D5). */
export const THIN_OBSERVATIONS = 3;

const FAILING = new Set(['failed', 'flaky']);

/** Why the brief abstains, or null. Checked before any evidence is read. */
export function abstentionFor(timeline, target, suite) {
  const n = timeline.observations.length;
  if (n === 0) {
    return {
      reason: `no observation of this test in ${timeline.runsInStore} run(s) in the store`,
    };
  }
  if (!suite && timeline.suites.length > 1) {
    return {
      reason: `the test name occurs in ${timeline.suites.length} suites; pass --suite to pick one`,
      suites: timeline.suites,
    };
  }
  if (!target)
    return { reason: `no failing observation in ${n} observation(s)` };
  return null;
}

function fidelityOf(abstained, observations, diffRead) {
  if (abstained) return 'abstained';
  if (observations < THIN_OBSERVATIONS) return 'thin';
  return diffRead ? 'history+diff' : 'history';
}

const strip = ({ signal, source, detail }) => ({ signal, source, detail });

function placeRows(rows) {
  return HYPOTHESES.map((id) => ({
    id,
    for: rows.filter((r) => r.supports.includes(id)).map(strip),
    against: rows.filter((r) => r.weighsAgainst.includes(id)).map(strip),
  }));
}

const isNeutral = (r) => !r.supports.length && !r.weighsAgainst.length;

function evidenceRows(input, findingsEv) {
  const { timeline, target, diff } = input;
  return [
    ...historySignals(timeline.observations, target),
    ...categoryRows(target),
    ...coFailureRows(target),
    ...diff.rows,
    ...findingsEv.rows,
  ];
}

// An abstained brief reads neither the diff nor the findings. Saying so keeps
// "Not checked" from ever reading as "every source was read" (C1).
const ABSTAINED_UNREAD = 'not read: brief abstained';

function abstainedUnread(input) {
  const out = [{ source: 'git diff', reason: ABSTAINED_UNREAD }];
  if (input.findings !== null && input.findings !== undefined) {
    out.push({ source: 'detector findings', reason: ABSTAINED_UNREAD });
  }
  return out;
}

function notCheckedFor(input, findingsEv) {
  const out = [];
  if (input.historyDark) {
    out.push({ source: 'run history', reason: input.historyDark });
  }
  if (input.timeline.skipped) {
    out.push({
      source: 'skipped observations',
      reason: `${input.timeline.skipped} skipped observation(s) carry no pass/fail evidence`,
    });
  }
  if (input.abstained) return [...out, ...abstainedUnread(input)];
  if (!resolveCategory(input.target)) {
    out.push({
      source: 'failure category',
      reason:
        'the target observation records neither failure_category nor error_text',
    });
  }
  return [...out, ...input.diff.notChecked, ...findingsEv.notChecked];
}

const shaOf = (o) => o.commit_sha ?? 'an unrecorded commit';

function abstainedStep(input) {
  if (input.abstained.suites) {
    return `Re-run with --suite set to one of: ${input.abstained.suites.join(', ')}.`;
  }
  return `Record runs of ${input.test} into the history store (canary history record) until a failing observation exists to examine.`;
}

function rangeSteps(target, lastPass) {
  if (!lastPass) return [];
  return [
    `Check out ${shaOf(lastPass)} with only the test file taken from ${shaOf(target)} and run it (isolates a test change).`,
    `Run the test from ${shaOf(target)} against the system under test at ${shaOf(lastPass)} (isolates a product change).`,
  ];
}

function disambiguation(input, fidelity) {
  if (input.abstained) return [abstainedStep(input)];
  const { test, target, lastPass, timeline } = input;
  const steps = [
    `Re-run ${test} several times at ${shaOf(target)} and compare outcomes (nondeterminism check).`,
  ];
  if (target.test_file) {
    steps.push(
      `Run canary-savant --confirm on ${target.test_file} (order dependence).`,
    );
  }
  steps.push(...rangeSteps(target, lastPass));
  if (fidelity === 'thin') {
    steps.push(
      `Record more runs: ${timeline.observations.length} of ${THIN_OBSERVATIONS} observations so far.`,
    );
  }
  return steps;
}

function targetSummary(target, lastPass) {
  if (!target) return {};
  const { coFailures, testsInRun, error_text, ...rest } = target;
  return {
    ...rest,
    co_failures: coFailures.length,
    tests_in_run: testsInRun,
    last_pass_commit_sha: lastPass?.commit_sha ?? null,
  };
}

// The helpers below keep assembleBrief itself under the perf complexity rule.

function findingsFor(input) {
  if (input.abstained) return { rows: [], notChecked: [] };
  return findingsEvidence(input.findings, input.target.test_file);
}

const briefSuite = (input) => input.suite ?? input.target?.suite ?? null;

function denominatorOf(timeline) {
  return {
    observations: timeline.observations.length,
    failures: timeline.observations.filter((o) => FAILING.has(o.status)).length,
    runs_in_store: timeline.runsInStore,
  };
}

/**
 * @param {object} input {test, suite, historyDark, timeline, target, lastPass,
 *   abstained, diff, findings} -- diff is null when abstained
 */
export function assembleBrief(input) {
  const { timeline, target, abstained } = input;
  const denominator = denominatorOf(timeline);
  const fidelity = fidelityOf(
    abstained,
    denominator.observations,
    Boolean(input.diff?.read),
  );
  const findingsEv = findingsFor(input);
  const rows = abstained ? [] : evidenceRows(input, findingsEv);
  return {
    schema_version: 1,
    advisory: true,
    test: input.test,
    suite: briefSuite(input),
    fidelity,
    denominator,
    // Abstained => no target shown, even when one exists (ambiguous suite, D6).
    target: targetSummary(abstained ? null : target, input.lastPass),
    hypotheses: placeRows(rows),
    neutral: rows.filter(isNeutral).map(strip),
    not_checked: notCheckedFor(input, findingsEv),
    disambiguate: disambiguation(input, fidelity),
    abstained: abstained ?? null,
  };
}

// ---------------------------------------------------------------------------
// Rendering. Copy is guarded by the SC9 test: no verdict language anywhere in
// the output except this one disclaimer, which the spec mandates verbatim.

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
