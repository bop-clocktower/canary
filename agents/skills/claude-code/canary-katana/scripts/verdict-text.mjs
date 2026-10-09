// verdict-text -- when a katana run abstains, and how it says so in text.
//
// A run is `{scanned, degraded, deletions, verdict}`: whether the diff had any
// text, whether critical-area data was missing, what was captured, and what
// alarm.assess returned.

import { DEGRADED_NOTICE } from './alarm.mjs';

// --- no-silent-abstention (#508 D2, skill-CLI convention half) ---------------
//
// Skill CLIs are deliberately self-contained -- no engine import -- so they
// cannot call `gateOutcome`. They honour the doctrine by CONVENTION, emitting
// the same greppable line the engine helper does; the skill-layer conformance
// registry (agents/skills/test/gate-conformance.test.ts) holds them to it.
//
// U+26A0 / U+2014 as escapes so this source stays ASCII, matching
// ts/src/core/gate-result.ts.
const ABSTAINED_LINE =
  '\u{26A0} Abstained \u{2014} verified zero items; this is not a pass.';

const notAssessedLine = (n) =>
  `\u{26A0} Abstained on ${n} critical area(s) this diff put at risk \u{2014} ` +
  'katana cannot tell whether they lost coverage, so 0 alarms is not a pass.';

const zeroAreasLine = (n) =>
  `${ABSTAINED_LINE} The critical-areas file lists 0 areas, so none of ` +
  `${n} deletion(s) could be checked against one.`;

const atStakeCount = (verdict) =>
  verdict.notAssessed.filter((n) => n.atStake).length;

/** Deletions were captured but the areas file names no area to check them on. */
const zeroAreas = (run) =>
  !run.degraded && run.verdict.total === 0 && run.deletions.length > 0;

/**
 * Abstain on an empty diff; on deletions with an empty areas list (a zero
 * denominator, #1246 review); or on no findings when the diff touched an area
 * katana cannot alarm on, where silence means "could not tell". Findings
 * outrank the area abstention (ADR 0009): an alarm proves a real check ran.
 */
export const abstains = (run) =>
  !run.scanned ||
  zeroAreas(run) ||
  (run.verdict.findings.length === 0 && atStakeCount(run.verdict) > 0);

/**
 * The area denominator (#1242), printed whenever any area is not assessed so
 * "0 alarms" can be told apart from "unable to alarm".
 */
function renderAreas({ total, notAssessed }) {
  if (!notAssessed.length) return [];
  const head = `${notAssessed.length} of ${total} critical area(s) not assessed (katana cannot alarm on them, or cannot tell):`;
  const stake = (n) => (n.atStake ? ' [at stake in this diff]' : '');
  return [
    head,
    ...notAssessed.map(
      (n) => `  [${n.reason}] ${n.area}${stake(n)}: ${n.evidence}`,
    ),
  ];
}

export function renderText(run) {
  // #508: katana's denominator is the DIFF it read, not the deletions it found.
  // Zero deletions in a 500-line diff is a real result; zero deletions in an
  // EMPTY diff means nothing was examined at all. `0 deletion(s) captured` reads
  // identically in both cases, which is precisely the shape the doctrine bans.
  if (!run.scanned) {
    return (
      `${ABSTAINED_LINE} The diff was empty, so no deleted test could be ` +
      'captured. Check --repo/--diff-file, or that the range actually ' +
      'contains changes.'
    );
  }
  const { findings } = run.verdict;
  const lines = [`${run.deletions.length} deletion(s) captured.`];
  if (run.degraded) lines.push(DEGRADED_NOTICE);
  if (zeroAreas(run)) lines.push(zeroAreasLine(run.deletions.length));
  for (const f of findings) {
    lines.push(
      `  [${f.severity.value}] ${f.file}::${f.test} removed the last coverage of ${f.area}`,
    );
  }
  lines.push(...renderAreas(run.verdict));
  const atStake = atStakeCount(run.verdict);
  if (!findings.length && atStake) lines.push(notAssessedLine(atStake));
  return lines.join('\n');
}
