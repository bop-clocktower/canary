/** Text rendering for `canary history gaps` (#610). Pure. */
import type { Scope } from './consumers.js';
import type { ConsumerGap, GapReport, RequirementCoverage } from './gaps.js';

const EM_DASH = '\u{2014}';

const UNIT: Record<Scope, string> = {
  run: 'runs',
  test: 'tests',
  'failed-test': 'failed tests',
};

function statusLabel(gap: ConsumerGap): string {
  if (gap.status === 'unmeasured') return 'unmeasured (no applicable rows)';
  // An opt-in consumer is dark by design until its flag is used; naming the
  // flag keeps that from reading as a writer defect.
  if (gap.status === 'dark' && gap.optIn !== undefined) {
    return `dark (fed only by \`history record ${gap.optIn}\`)`;
  }
  return gap.status;
}

function coverageLine(c: RequirementCoverage): string {
  return `      ${c.field}: ${c.carried}/${c.applicable} ${UNIT[c.scope]}`;
}

/** One header line, then each consumer with its per-field coverage. */
export function renderGapReport(
  report: GapReport,
  meta: { path: string },
): string {
  const lines = [
    `canary history gaps ${EM_DASH} ${meta.path}: ` +
      `${report.runs} run(s), ${report.tests} test(s)`,
    '',
  ];
  for (const gap of report.consumers) {
    lines.push(`  ${gap.id}: ${statusLabel(gap)} ${EM_DASH} ${gap.surface}`);
    for (const c of gap.coverage) lines.push(coverageLine(c));
  }
  return lines.join('\n');
}

/** A missing or empty store: say why, and name what went dark with it. */
export function renderAbstention(
  reason: string,
  consumerIds: readonly string[],
): string {
  return (
    `canary history gaps ${EM_DASH} ${reason}\n` +
    `  dark by abstention: ${consumerIds.join(', ')}`
  );
}
