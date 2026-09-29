/**
 * Markdown rendering of a release dossier (#611).
 *
 * The header answers the question first -- is the evidence complete, and how
 * many sections were dark -- then Worth your eyes, then one section per
 * source. A dark section prints its reason where a fed one prints facts, so
 * it can never be skimmed as a clean section.
 */

import type { Dossier } from './assemble.js';
import { SECTION_TITLES, type Section, type SourceRef } from './types.js';

const EM_DASH = '\u{2014}';

const VERDICT_GLOSS: Record<Dossier['verdict'], string> = {
  complete: 'every evidence source was read or declared out of scope',
  incomplete:
    'at least one evidence source was dark; the dossier cannot vouch for what it did not read',
  abstained: 'no evidence source was read, so this dossier says nothing',
};

function header(d: Dossier): string[] {
  const { fed, dark, excluded } = d.counts;
  return [
    `# Release quality dossier: ${d.release}`,
    '',
    `**Evidence verdict:** ${d.verdict.toUpperCase()} ${EM_DASH} ${VERDICT_GLOSS[d.verdict]}.`,
    `**Sections:** ${fed} fed, ${dark} dark, ${excluded} excluded`,
    `**Content digest (sha256):** \`${d.digest}\``,
    `**Generated:** ${d.generatedAt}`,
    '',
    'This grades the evidence behind the release, not the release itself. ' +
      'Check the digest with `canary manhunter verify <dossier.json>`.',
    '',
  ];
}

function eyesBlock(d: Dossier): string[] {
  const lines = ['## Worth your eyes', ''];
  if (d.worthYourEyes.length === 0) {
    const scope = d.counts.excluded > 0 ? 'fed or excluded' : 'fed';
    lines.push(
      `Nothing flagged. Every section was ${scope} and none raised an item.`,
    );
  } else {
    for (const item of d.worthYourEyes) {
      lines.push(`- **${SECTION_TITLES[item.section]}:** ${item.text}`);
    }
  }
  lines.push('');
  return lines;
}

function sourceLine(ref: SourceRef): string {
  const state =
    ref.sha256 === null ? 'not read' : `sha256 ${ref.sha256.slice(0, 12)}`;
  return `\`${ref.path}\` (${state})`;
}

function sectionBlock(s: Section): string[] {
  const lines = [`## ${s.title}: ${s.status.toUpperCase()}`, ''];
  if (s.reason !== null) lines.push(`**Reason:** ${s.reason}`, '');
  if (s.sources.length > 0) {
    lines.push(`**Sources:** ${s.sources.map(sourceLine).join(', ')}`, '');
  }
  if (s.denominator !== null) {
    lines.push(`**Measured over:** ${s.denominator}`, '');
  }
  for (const fact of s.facts) lines.push(`- ${fact}`);
  if (s.facts.length > 0) lines.push('');
  return lines;
}

export function renderDossier(d: Dossier): string {
  const lines = [...header(d), ...eyesBlock(d)];
  for (const s of d.sections) lines.push(...sectionBlock(s));
  return lines.join('\n').trimEnd() + '\n';
}
