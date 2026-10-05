/**
 * Markdown for canary-judomaster (#614): the regression brief and the verify
 * report. The verify report leads with the verdict and prints labels
 * verbatim; `unverified` and `not-reproduced` are never softened.
 */

import type { RegressionBrief, ResolvedFrame } from './types.js';
import type { VerifyResult } from './verify.js';

const VACUITY =
  'VACUITY RED FLAG: the test passed against the code it was written to catch';

function where(frame: ResolvedFrame): string {
  return `${frame.path ?? frame.file}:${frame.line}`;
}

function suspectLine(brief: RegressionBrief): string {
  const s = brief.suspect;
  if (s === null) return '- Suspect: none (no frame resolves inside the root)';
  const fn = s.fn === undefined ? '' : ` in \`${s.fn}\``;
  return `- Suspect: \`${where(s)}\`${fn} (${s.status})`;
}

function excerptBlock(brief: RegressionBrief): string[] {
  const lines = brief.suspect?.excerpt;
  if (lines === undefined || lines.length === 0) return [];
  return ['', '## Excerpt', '', '```text', ...lines, '```'];
}

type Link = NonNullable<RegressionBrief['chain']>[number];
const relationWord = (l: Link) =>
  l.relation === 'cause' ? 'caused by' : 'while handling';

function chainBlock(brief: RegressionBrief): string[] {
  const chain = brief.chain;
  if (chain === undefined) return [];
  const links = chain.map((l, i) => {
    const at = l.suspect === null ? '' : ` at \`${where(l.suspect)}\``;
    const root = i === chain.length - 1 ? ' (root cause)' : '';
    return `${i + 2}. ${relationWord(l)} ${l.errorType}: ${l.message}${at}${root}`;
  });
  return [
    '',
    '## Exception chain (reported first)',
    '',
    `1. ${brief.errorType}: ${brief.message} (reported)`,
    ...links,
  ];
}

function frameLines(brief: RegressionBrief): string[] {
  return brief.frames.flatMap((f, i) => {
    const marks = (brief.chain ?? [])
      .filter((l) => l.start === i)
      .map((l) => `- --- ${relationWord(l)} ${l.errorType}: ${l.message} ---`);
    const fn = f.fn === undefined ? '' : ` in \`${f.fn}\``;
    return [...marks, `- \`${where(f)}\`${fn}: ${f.status}`];
  });
}

/** Render the regression brief as markdown. */
export function renderBrief(brief: RegressionBrief): string {
  return [
    `# Regression brief: ${brief.errorType}`,
    '',
    suspectLine(brief),
    `- Signature (${brief.signature.kind}): ${brief.signature.text}`,
    `- Framework: ${brief.framework}`,
    `- Output: \`${brief.outputPath}\``,
    '',
    '## Requirement',
    '',
    brief.requirement,
    ...excerptBlock(brief),
    ...chainBlock(brief),
    '',
    '## Frames (innermost first)',
    '',
    ...frameLines(brief),
    '',
  ].join('\n');
}

/** Runner output for a run that was not a reproduction, so a red run shows why. */
function tailBlock(result: VerifyResult): string[] {
  const tail = result.tail ?? [];
  if (result.verdict === 'reproduced' || tail.length === 0) return [];
  return [
    `## Runner output (last ${tail.length} lines)`,
    '',
    '```text',
    ...tail,
    '```',
    '',
  ];
}

/** Render a verify result as markdown, verdict first. */
export function renderVerify(result: VerifyResult): string {
  const { verdict, label } = result;
  const heading = label.startsWith(verdict) ? label : `${verdict} (${label})`;
  return [
    `# Verdict: ${heading}`,
    '',
    ...(result.vacuity ? [VACUITY, ''] : []),
    ...(result.warnings ?? []).flatMap((w) => [`WARNING: ${w}`, '']),
    `Reason: ${result.reason}`,
    '',
    ...tailBlock(result),
  ].join('\n');
}
