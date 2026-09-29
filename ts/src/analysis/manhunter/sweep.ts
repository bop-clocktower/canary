/**
 * Accessibility-sweep section (#611): the JSON report canary-sweep writes
 * with `--json-out` (version 1).
 *
 * The sweep has no conventional path, so no `--sweep` is DARK (or declare it
 * out with `--exclude sweep=<reason>` for a project with no UI). A report that
 * abstained -- no axe document read, or no rule evaluated -- is DARK with the
 * sweep's own reason; zero violations counts only when rules were evaluated.
 */

import { parseJsonSource, readSource, sourceRef } from './sources.js';
import { darkSection, fedSection, isRecord, type Section } from './types.js';

const SERIOUS_IMPACTS = ['critical', 'serious'];

interface SweepFinding {
  component: string;
  rule: string;
  impact: string;
  occurrences: number;
}

function toFinding(raw: unknown): SweepFinding {
  const f = isRecord(raw) ? raw : {};
  return {
    component: typeof f.component === 'string' ? f.component : '(unattributed)',
    rule: typeof f.rule === 'string' ? f.rule : '?',
    impact: typeof f.impact === 'string' ? f.impact : 'unknown',
    occurrences: typeof f.occurrences === 'number' ? f.occurrences : 0,
  };
}

const count = (v: unknown): number => (typeof v === 'number' ? v : 0);

/**
 * Why the report cannot feed the section, or null. A report whose shape is not
 * canary-sweep v1 -- or whose findings array disagrees with its own summary --
 * is refused, never coerced to "no findings".
 */
function unusable(
  report: Record<string, unknown>,
  summary: Record<string, unknown>,
): string | null {
  if (report.version !== 1) return 'the sweep report is not canary-sweep v1';
  if (summary.abstained === true) {
    const why =
      typeof summary.abstention_reason === 'string'
        ? summary.abstention_reason
        : 'no reason given';
    return `the sweep report abstained: ${why}`;
  }
  if (count(summary.rule_evaluations) === 0) {
    return 'the sweep report evaluated 0 rules';
  }
  if (
    !Array.isArray(report.findings) ||
    report.findings.length !== summary.findings
  ) {
    return 'the sweep report findings array is missing or disagrees with summary.findings';
  }
  return null;
}

export function sweepSection(path: string | null): Section {
  if (path === null) {
    return darkSection(
      'sweep',
      [],
      'no sweep report was given (--sweep <report.json>); declare --exclude sweep=<reason> if the release has no UI surface',
    );
  }
  const read = readSource(path);
  const ref = sourceRef(read);
  const parsed = parseJsonSource(read);
  if (!parsed.ok) return darkSection('sweep', [ref], parsed.reason);
  const report = isRecord(parsed.value) ? parsed.value : {};
  const summary = isRecord(report.summary) ? report.summary : {};
  const refused = unusable(report, summary);
  if (refused !== null) return darkSection('sweep', [ref], refused);
  const findings = (report.findings as unknown[]).map(toFinding);
  const unattributed = count(summary.unattributed_nodes);
  const eyes = findings
    .filter((f) => SERIOUS_IMPACTS.includes(f.impact))
    .map(
      (f) =>
        `${f.component}: ${f.rule} (${f.impact}, ${f.occurrences} occurrences)`,
    );
  if (unattributed > 0) {
    eyes.push(
      `${unattributed} violating nodes could not be attributed to a component`,
    );
  }
  return fedSection('sweep', {
    sources: [ref],
    denominator: `${count(summary.pages)} pages, ${count(summary.rule_evaluations)} rule evaluations`,
    facts: [
      `${findings.length} component-level findings, ${count(summary.violation_nodes)} violating nodes`,
    ],
    eyes,
  });
}
