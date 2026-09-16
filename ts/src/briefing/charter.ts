/**
 * Render {@link BriefingFacts} as the facts half of a Markdown test charter
 * (#593, spec sections 1, 5, 6, 7).
 *
 * Two rules shape every line here. First, the charter must never read as a
 * gate result: no pass/fail vocabulary, no status glyph, and an explicit
 * "advisory, not a gate" in the heading, because the guardian's sticky comment
 * IS a gate and a tester must be able to tell them apart at a glance. Second,
 * an absent measurement is written as unknown, never as an absence of problems
 * — "nothing covers it" and "nothing measured it" are different sentences.
 */

import type { BriefingFacts, BriefingUnit } from './facts.js';

/** The charter's own heading — deliberately carries its own disclaimer. */
export const CHARTER_HEADING = '## Test charter (advisory, not a gate)';

const ADVISORY_LINE =
  'This is not a verdict, and it changes no check. The guardian comment is ' +
  'the gate; this is a plan for a person.';

/** What a unit's coverage cell says, in the charter's own vocabulary. */
function coverageCell(unit: BriefingUnit): string {
  if (unit.coverage === 'unknown') return 'coverage unknown';
  return unit.execution_evidence ?? 'coverage unknown';
}

function importsCell(unit: BriefingUnit): string {
  if (unit.imported_by === null) return 'inventory unavailable';
  if (unit.imported_by.length === 0) return 'none found';
  return unit.imported_by.map((p) => `\`${p}\``).join(', ');
}

function rangesText(unit: BriefingUnit): string {
  return unit.added_ranges
    .map(([start, end]) => (start === end ? `${start}` : `${start}-${end}`))
    .join(', ');
}

/** Section 1: provenance plus an availability line for every optional input. */
function headerLines(facts: BriefingFacts): string[] {
  const ranking =
    facts.risk_ranking === 'available'
      ? 'available (highest risk first)'
      : 'unavailable (diff order)';
  return [
    CHARTER_HEADING,
    '',
    ADVISORY_LINE,
    '',
    facts.provenance,
    '',
    `Coverage: ${facts.coverage.status} \u{b7} Inventory: ${facts.inventory} ` +
      `\u{b7} Risk ranking: ${ranking}`,
  ];
}

/** Section 5: one row per unit, execution and static imports kept apart. */
function existingTestLines(facts: BriefingFacts): string[] {
  const rows = facts.units.map(
    (u) => `| \`${u.path}\` | ${coverageCell(u)} | ${importsCell(u)} |`,
  );
  return [
    '### Existing tests',
    '',
    '| Unit | Executed by (Tier-0) | Imports the module |',
    '| --- | --- | --- |',
    ...rows,
    '',
    'The two columns are different evidence: the first is a measured coverage ' +
      'run, the second is a static import match from the test inventory, ' +
      'which says a test mentions the module and nothing more.',
  ];
}

/**
 * Section 6: what has no measured execution behind it.
 *
 * A unit coverage never measured is listed as unknown, and the line says so —
 * it is NOT evidence that nothing exercises those lines.
 */
function nothingCoversLines(facts: BriefingFacts): string[] {
  const lines = ['### Nothing covers', ''];
  const measured = facts.units.filter((u) => u.coverage === 'uncovered');
  const unknown = facts.units.filter((u) => u.coverage === 'unknown');
  if (measured.length === 0 && unknown.length === 0) {
    lines.push(
      'Every changed unit was measured and every added line it could ' +
        'speak to ran at least once.',
    );
    return lines;
  }
  for (const unit of measured) {
    const lineList =
      unit.uncovered_lines.length > 0
        ? unit.uncovered_lines.join(', ')
        : rangesText(unit);
    const noun = unit.uncovered_lines.length === 1 ? 'line' : 'lines';
    lines.push(
      `- \`${unit.path}\` ${noun} ${lineList} \u{2014} measured, not executed`,
    );
  }
  for (const unit of unknown) {
    lines.push(
      `- \`${unit.path}\` lines ${rangesText(unit)} \u{2014} coverage unknown; ` +
        'nothing measured these lines, so this is not a claim about them',
    );
  }
  return lines;
}

/** Section 7: the edges of the plan — what was deliberately left out. */
function outOfCharterLines(facts: BriefingFacts): string[] {
  const lines = ['### Out of this charter', ''];
  if (facts.skipped.length === 0) {
    lines.push('Nothing the diff touched was filtered out.', '');
  } else {
    for (const skip of facts.skipped) {
      lines.push(`- \`${skip.path}\` \u{2014} ${skip.reason}`);
    }
  }
  if (facts.inventory === 'unavailable') {
    lines.push(
      '- Static import matches: inventory unavailable, so the imports column ' +
        'is blank rather than empty. Run `canary inventory` to populate it.',
    );
  }
  if (facts.risk_ranking === 'unavailable') {
    lines.push(
      '- Risk ranking: unavailable, so units are in diff order rather than ' +
        'by risk.',
    );
  }
  lines.push(
    '',
    'What to explore by hand and which edge cases this diff invites are not ' +
      'here: those come from the `canary-mission-briefing` skill, which reads ' +
      'these same facts.',
  );
  return lines;
}

/** Render the whole facts charter as Markdown. */
export function renderCharter(facts: BriefingFacts): string {
  return [
    ...headerLines(facts),
    '',
    ...existingTestLines(facts),
    '',
    ...nothingCoversLines(facts),
    '',
    ...outOfCharterLines(facts),
    '',
  ].join('\n');
}
