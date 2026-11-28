// render -- the Markdown scorecard, in the batgirl voice
// (voice/profiles/batgirl.md): open on the sweep, enumerate, name every gap,
// close on the gap ledger.
//
// Every value that can carry input text (basis, source, reason) goes through
// `md`. Titles, directions and numbers are batgirl's own.

import { md, plain } from './text.mjs';

const DOT = '\u00b7';

const SCHEMA_VERSION = 1;

const nullable = (v) => (v === null || v === undefined ? null : plain(v));

/** Every string that can carry input text goes through `plain`. */
function jsonDimension(d) {
  return {
    id: d.id,
    title: d.title,
    better: d.better,
    kind: d.kind,
    status: d.status,
    value: d.value,
    basis: nullable(d.basis),
    source: nullable(d.source),
    reason: nullable(d.reason),
    detail: d.detail,
  };
}

/** The `--json` report. Every key is batgirl's own; no key comes from input. */
export function renderJson(report) {
  return JSON.stringify(
    {
      schema_version: SCHEMA_VERSION,
      abstained: report.abstained,
      assessed: report.assessed,
      dimensions: report.dimensions.map(jsonDimension),
    },
    null,
    2,
  );
}

function formatValue(d) {
  if (d.status !== 'assessed') return 'not assessed';
  if (d.kind === 'ratio') return `${(d.value * 100).toFixed(1)}%`;
  return String(d.value);
}

function row(d) {
  const basis = d.basis === null ? '-' : md(d.basis);
  const source = d.source === null ? '-' : md(d.source);
  return `| ${d.title} | ${formatValue(d)} | ${d.better} | ${basis} | ${source} |`;
}

function gapLines(gaps) {
  if (gaps.length === 0) return [];
  return [
    '',
    `Not assessed: ${gaps.length}.`,
    '',
    ...gaps.map((d) => `- ${d.title}: ${md(d.reason)}`),
  ];
}

/** @param {{abstained: boolean, assessed: number, dimensions: object[]}} report */
export function renderMarkdown(report) {
  const dims = report.dimensions;
  const gaps = dims.filter((d) => d.status !== 'assessed');
  const lines = [
    '# canary-batgirl: team quality scorecard',
    '',
    `SWEEP: team scorecard ${DOT} ${dims.length} dimensions ${DOT} ` +
      `${report.assessed} assessed`,
    '',
    'Team-level only: no per-person score, rank, streak or badge. No ' +
      'composite: each dimension stands alone, with its own direction. ' +
      'Report only, never a gate.',
    '',
    '| Dimension | Value | Better | Basis | Source |',
    '| --- | --- | --- | --- | --- |',
    ...dims.map(row),
    ...gapLines(gaps),
  ];
  if (report.abstained) {
    lines.push('', 'Abstained: no dimension had backing data. Nothing scored.');
  }
  const ids = gaps.map((d) => d.id).join(', ');
  lines.push(
    '',
    gaps.length
      ? `Gaps: ${gaps.length} (${ids}). Closing.`
      : 'Gaps: 0. Closing.',
  );
  return lines.join('\n');
}
