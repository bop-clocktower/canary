// render -- assemble the brief and print it as Markdown or JSON (#666).
//
// Every dynamic value goes through escape.mjs: `md` for Markdown, `cleanDeep`
// for JSON. The brief never carries a verdict or a pass line. On abstention it
// carries the family's ABSTAINED_LINE (mirrors gateOutcome in
// ts/src/core/gate-result.ts; U+26A0 and U+2014 written as escapes so this
// source stays ASCII).

import { cleanDeep, md } from './escape.mjs';

const SCHEMA_VERSION = 1;

export const ABSTAINED_LINE =
  '\u{26A0} Abstained \u{2014} verified zero items; this is not a pass.';

/** Rows printed per Markdown section; JSON carries all of them. */
export const MAX_ROWS = 25;

/** risk_score at or above which failure impact is suggested (katana's). */
const HIGH_RISK = 0.7;

const MAX_EDGE_SUGGESTIONS = 5;

const TITLES = {
  risk: 'Risk',
  ties: 'Test ties (gap analysis)',
  isolation: 'Isolation smells',
  temporal: 'Temporal dependence',
};

const checkedTotal = (members) =>
  members.reduce((sum, m) => sum + m.checked, 0);

function abstainReason(target, members) {
  if (target.abstain) return target.abstain;
  if (checkedTotal(members) > 0) return null;
  const why = [...new Set(members.map((m) => m.reason).filter(Boolean))];
  return `no member checked any of the ${target.files.length} file(s) in the target (${why.join('; ')})`;
}

const rowsOf = (members, name) =>
  members.find((m) => m.name === name && m.status === 'ran')?.rows ?? [];

/** Gaps first, then by risk: the order an agent should spend attention in. */
function suggestions(members) {
  const risk = new Map(rowsOf(members, 'risk').map((r) => [r.path, r]));
  const scoreOf = (p) => risk.get(p)?.risk_score ?? 0;
  const ranked = [...rowsOf(members, 'ties')].sort(
    (a, b) =>
      Number(a.tied) - Number(b.tied) || scoreOf(b.path) - scoreOf(a.path),
  );
  const edge = ranked.slice(0, MAX_EDGE_SUGGESTIONS).map((r) => ({
    command: '/canary-edge-cases',
    path: r.path,
    why: r.tied ? 'changed, tied' : 'changed, no test ties to it',
  }));
  const impact = [...risk.values()]
    .filter((r) => r.risk_score >= HIGH_RISK)
    .map((r) => ({
      command: '/canary-failure-impact',
      path: r.path,
      why: `risk ${r.risk_score}`,
    }));
  return [...edge, ...impact];
}

function targetSummary(target) {
  const count = (kind) => target.files.filter((f) => f.kind === kind).length;
  return {
    mode: target.mode,
    base: target.base,
    base_ref: target.baseRef,
    files: target.files.length,
    source: count('source'),
    test: count('test'),
    other: count('other'),
    deleted: target.deleted,
    clamped: target.clamped,
    notes: target.notes,
  };
}

/** The brief, as a plain object; renderers only format it. */
export function buildBrief({ target, members, budgetMs, elapsedMs }) {
  const reason = abstainReason(target, members);
  return {
    schema_version: SCHEMA_VERSION,
    advisory: true,
    abstained: reason !== null,
    reason,
    target: targetSummary(target),
    members,
    suggestions: reason === null ? suggestions(members) : [],
    budget_ms: budgetMs,
    elapsed_ms: elapsedMs,
  };
}

export function renderJson(brief) {
  return JSON.stringify(cleanDeep(brief), null, 2);
}

// --- Markdown ---------------------------------------------------------------

function targetLine(t) {
  const where =
    t.mode === 'paths'
      ? 'named paths'
      : `working diff against ${md(t.base_ref ?? 'an empty repository')}${t.base && t.base !== 'HEAD' ? ` (merge base ${md(t.base.slice(0, 12))})` : ''}`;
  const extra = [
    t.deleted
      ? `${t.deleted} deleted (not analysed; canary-katana covers deletions)`
      : '',
    t.clamped ? `${t.clamped} more not analysed (clamped)` : '',
  ].filter(Boolean);
  return `Target: ${where}: ${t.files} file(s), ${t.source} source, ${t.test} test, ${t.other} other${extra.length ? `; ${extra.join('; ')}` : ''}.`;
}

const ROW_FORMAT = {
  risk: (r) => `- ${md(r.path)}: risk ${md(r.risk_score)}`,
  ties: (r) =>
    r.tied
      ? `- ${md(r.path)}: tied to ${r.tests.map((t) => md(t)).join(', ')}${r.test_count > r.tests.length ? ` (+${r.test_count - r.tests.length} more)` : ''}`
      : `- ${md(r.path)}: **no test ties to it**`,
  scan: (r) =>
    `- ${md(r.file)}:${md(r.line)} ${md(r.rule_id)} (${md(r.severity)}): ${md(r.why)}`,
};

const EMPTY_TEXT = {
  risk: 'No changed file is in the map.',
  ties: 'No changed source file.',
};

function rowLines(m) {
  if (!m.rows.length) return [EMPTY_TEXT[m.name] ?? 'No finding.'];
  const format = ROW_FORMAT[m.name] ?? ROW_FORMAT.scan;
  const lines = m.rows.slice(0, MAX_ROWS).map(format);
  const more = m.rows.length - MAX_ROWS;
  return more > 0 ? [...lines, `- ... and ${more} more (see --json)`] : lines;
}

const STATUS_TEXT = {
  'not-checked': 'Not checked',
  budget: 'Not run',
  error: 'Error',
};

function memberLines(m) {
  const head = `## ${TITLES[m.name] ?? md(m.name)} (${md(m.skill)})`;
  if (m.status !== 'ran') {
    return [
      head,
      '',
      `${STATUS_TEXT[m.status] ?? md(m.status)}: ${md(m.reason)}`,
    ];
  }
  const detail = m.detail ? ` ${md(m.detail)}.` : '';
  return [
    head,
    '',
    `Checked ${m.checked} file(s).${detail}`,
    '',
    ...rowLines(m),
  ];
}

function suggestionLines(brief) {
  if (!brief.suggestions.length) return [];
  return [
    '## Suggested next',
    '',
    ...brief.suggestions.map(
      (s) => `- \`${s.command}\` ${md(s.path)}: ${md(s.why)}`,
    ),
    '',
    'Confirm with the user before running `/canary-write-test` on any case. Nothing is generated automatically.',
  ];
}

function notesLines(brief) {
  const notes = brief.target.notes;
  return notes.length
    ? ['## Notes', '', ...notes.map((n) => `- ${md(n)}`)]
    : [];
}

function abstainedLines(brief) {
  return [
    ABSTAINED_LINE,
    '',
    `Reason: ${md(brief.reason)}.`,
    '',
    'Make a change, or name a file: `canary skills run canary-dev-pipeline -- <path>`.',
  ];
}

export function renderMarkdown(brief) {
  const head = [
    '# Dev pipeline brief (advisory)',
    '',
    'Findings never change the exit code. Anything that should block belongs in canary-pr-guardian.',
    '',
  ];
  if (brief.abstained) return [...head, ...abstainedLines(brief)].join('\n');
  const sections = [
    ...brief.members.map(memberLines),
    suggestionLines(brief),
    notesLines(brief),
  ].filter((s) => s.length);
  return [
    ...head,
    targetLine(brief.target),
    `Budget: ${brief.budget_ms} ms, used ${brief.elapsed_ms} ms.`,
    '',
    sections.map((s) => s.join('\n')).join('\n\n'),
  ].join('\n');
}
