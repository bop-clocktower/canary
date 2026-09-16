/** Markdown for charter sections 2-4 and the dropped-judgment lines (#593). */
import {
  EDGE_CASE_CATEGORIES,
  type DroppedItem,
  type JudgmentResult,
} from './judgment.js';

function verifyLines(r: JudgmentResult): string[] {
  const lines = ['### Verify by hand', ''];
  if (r.verify.length === 0)
    return [...lines, 'No verify item cited a changed line.'];
  return [...lines, ...r.verify.map((v) => `- [ ] ${v.text} (\`${v.cite}\`)`)];
}

/** One `####` group per category that kept an item, in the skill's order. */
function edgeCaseLines(r: JudgmentResult): string[] {
  const lines = ['### Edge cases this diff invites', ''];
  if (r.edge_cases.length === 0)
    return [...lines, 'No edge case cited a changed line.'];
  for (const category of EDGE_CASE_CATEGORIES) {
    const items = r.edge_cases.filter((e) => e.category === category);
    if (items.length === 0) continue;
    lines.push(
      `#### ${category}`,
      '',
      ...items.map((e) => `- ${e.text} (\`${e.cite}\`)`),
      '',
    );
  }
  return lines.slice(0, -1);
}

/** Sections 2, 3 and 4, in charter order. */
export function judgmentLines(r: JudgmentResult): string[] {
  const mission = r.mission === '' ? [] : [`**Mission:** ${r.mission}`, ''];
  return [...mission, ...verifyLines(r), '', ...edgeCaseLines(r)];
}

/** Out-of-charter lines for items that did not cite a changed line. */
export function droppedLines(dropped: DroppedItem[]): string[] {
  return dropped.map((d) => {
    const kind = d.section === 'verify' ? 'verify item' : 'edge case';
    return `- Dropped ${kind} "${d.text}" \u{2014} ${d.reason}`;
  });
}
