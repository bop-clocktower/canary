/**
 * Mapping, suppression and rendering for the diff-scoped mutation report
 * (#486).
 *
 * Split from `mutation.ts` (the model, the diff scope and the runner guard)
 * only to keep both files inside the perf ratchet's 300-line budget; the model
 * lives there, the reading of a run lives here.
 *
 * Every function in this file obeys one rule: a report that verified nothing
 * says so. There is no code path that renders "0 survived", and a run whose
 * mutants only timed out abstains rather than reporting `all-killed` -- a
 * timeout is excluded from the killed numerator, so it cannot count as a kill
 * in the verdict either. Every non-abstained report renders its timeout count.
 */

import {
  MutantFinding,
  MutationReport,
  MutationStatus,
  MapOptions,
  StrykerReport,
  SuppressedMutant,
} from './mutation.js';

/** The `// canary:allow-mutant <reason>` marker, mirroring allow-untested. */
const SUPPRESS_MUTANT_RE = /(?:\/\/|#)\s*canary:allow-mutant\s+(.+)/;

export function abstainedReport(
  reason: string,
  excludedTests: string[],
): MutationReport {
  return {
    verdict: 'abstained',
    abstainReason: reason,
    generated: 0,
    sampled: 0,
    killed: 0,
    survived: 0,
    noCoverage: 0,
    timeout: 0,
    findings: [],
    suppressed: [],
    excludedTests,
  };
}

/** Stryker's status vocabulary, mapped onto guardian's. */
function toStatus(strykerStatus: string, coveredBy: string[]): MutationStatus {
  switch (strykerStatus) {
    case 'Killed':
      return 'killed';
    case 'Timeout':
      return 'timeout';
    case 'Survived':
      // SC-2: a survivor with nothing covering it is a coverage gap, which
      // guardian's coverage tier already reports. Calling it a weak assertion
      // would double-count it and dilute the false-survivor rate (D5).
      return coveredBy.length > 0 ? 'survived' : 'no-coverage';
    default:
      return 'no-coverage';
  }
}

/** Derive the verdict and abstention reason from the counted statuses. */
function verdictFor(
  report: Omit<MutationReport, 'verdict' | 'abstainReason'>,
): Pick<MutationReport, 'verdict' | 'abstainReason'> {
  if (report.sampled === 0) {
    return {
      verdict: 'abstained',
      abstainReason: 'the run produced zero mutants, which is not a pass',
    };
  }
  // A timeout is NOT a kill here. Stryker's own vocabulary counts one as a
  // kill (an infinite loop is a detected change), but this module excludes it
  // from the killed numerator, so treating it as a non-survivor too would let
  // a run that killed nothing report `all-killed` off a `0/N` headline --
  // wrong in both directions at once. Nothing killed is an abstention.
  if (report.killed === 0 && report.survived === 0) {
    return {
      verdict: 'abstained',
      abstainReason:
        report.timeout > 0
          ? `no mutant was killed and ${report.timeout} timed out, so the ` +
            'run verified nothing'
          : 'no mutant was covered by any test, so nothing could be killed',
    };
  }
  return { verdict: report.survived > 0 ? 'survivors' : 'all-killed' };
}

/** Recount a report's tallies from its findings and suppressions. */
function recount(report: MutationReport): MutationReport {
  const counts = { killed: 0, survived: 0, noCoverage: 0, timeout: 0 };
  for (const finding of report.findings) {
    if (finding.status === 'killed') counts.killed += 1;
    else if (finding.status === 'survived') counts.survived += 1;
    else if (finding.status === 'timeout') counts.timeout += 1;
    else counts.noCoverage += 1;
  }
  const next = { ...report, ...counts };
  return { ...next, ...verdictFor(next) };
}

/**
 * Map a Stryker JSON report onto {@link MutationReport}.
 *
 * `coveredBy` arrives as test ids; they are resolved to test names through the
 * report's `testFiles`, because "the tests that ran and did not fail" is the
 * actionable half of a survivor (Goal 2).
 */
export function mapStrykerReport(
  strykerReport: StrykerReport,
  options: MapOptions,
): MutationReport {
  const names = new Map<string, string>();
  for (const file of Object.values(strykerReport.testFiles ?? {})) {
    for (const test of file.tests) names.set(test.id, test.name);
  }

  const findings: MutantFinding[] = [];
  for (const [path, file] of Object.entries(strykerReport.files)) {
    for (const mutant of file.mutants) {
      const coveredBy = (mutant.coveredBy ?? []).map(
        (id) => names.get(id) ?? id,
      );
      findings.push({
        path,
        line: mutant.location.start.line,
        mutator: mutant.mutatorName,
        replacement: mutant.replacement ?? '',
        status: toStatus(mutant.status, coveredBy),
        coveredBy,
      });
    }
  }

  return recount({
    verdict: 'abstained',
    generated: options.generated ?? findings.length,
    sampled: findings.length,
    killed: 0,
    survived: 0,
    noCoverage: 0,
    timeout: 0,
    findings,
    suppressed: [],
    excludedTests: options.excludedTests,
  });
}

/**
 * Read a `// canary:allow-mutant <reason>` suppression off a source line.
 *
 * A bare marker with no reason returns `null`: the reason IS the artifact a
 * reviewer reads, so an unexplained suppression is not one. Mirrors
 * `suppressionReason` for `canary:allow-untested` (D9).
 */
export function mutantSuppressionReason(line: string): string | null {
  const match = SUPPRESS_MUTANT_RE.exec(line);
  if (match === null) return null;
  let reason = match[1]!.trim();
  for (const closer of ['*/', '-->']) {
    if (reason.endsWith(closer))
      reason = reason.slice(0, -closer.length).trim();
  }
  return reason.length > 0 ? reason : null;
}

/**
 * Move survivors whose line carries an explained suppression out of the count.
 *
 * `sources` maps a mutated path to its lines (1-based by index+1). A path the
 * caller could not read simply suppresses nothing -- an unreadable file must
 * never silently clear a survivor.
 */
export function applyMutantSuppressions(
  report: MutationReport,
  sources: Record<string, string[]>,
): MutationReport {
  const kept: MutantFinding[] = [];
  const suppressed: SuppressedMutant[] = [...report.suppressed];
  for (const finding of report.findings) {
    const line = sources[finding.path]?.[finding.line - 1];
    const reason =
      finding.status === 'survived' && line !== undefined
        ? mutantSuppressionReason(line)
        : null;
    if (reason === null) kept.push(finding);
    else suppressed.push({ finding, reason });
  }
  return recount({ ...report, findings: kept, suppressed });
}

/** ADR 0009 exit contract: 0 all-killed, 1 survivors, 3 abstained. */
export function mutationExitCode(report: MutationReport): number {
  if (report.verdict === 'abstained') return 3;
  return report.verdict === 'survivors' ? 1 : 0;
}

/** Survivors the author accepted in writing, listed with their reasons. */
function suppressionLines(report: MutationReport): string[] {
  return report.suppressed.map(
    (entry) =>
      `- suppressed \`${entry.finding.path}:${entry.finding.line}\`: ` +
      `${entry.reason}`,
  );
}

/** The disclosure line every report carries, abstentions included. */
function excludedLine(report: MutationReport): string {
  if (report.excludedTests.length === 0) {
    return 'No test files were excluded from the mutation run.';
  }
  return (
    `${report.excludedTests.length} test file(s) excluded from the mutation ` +
    `run (they cannot run in Stryker's worker-thread pool), so a mutant only ` +
    `these would kill reads as survived: ${report.excludedTests.join(', ')}`
  );
}

/** Render the report as the `### Mutation` comment/summary section (D-Output). */
export function renderMutationReport(report: MutationReport): string {
  const lines = ['### Mutation'];
  if (report.verdict === 'abstained') {
    lines.push(
      `Abstained ${'\u{2014}'} ${report.abstainReason ?? 'no reason given'}. ` +
        'This is not a pass.',
    );
    // Suppressions are listed even on an abstention: they are the reason the
    // denominator collapsed in the ONE case where it collapsed by choice.
    lines.push(...suppressionLines(report));
    lines.push('', excludedLine(report));
    return lines.join('\n');
  }

  const scope =
    report.sampled < report.generated
      ? ` (sampled ${report.sampled} of ${report.generated})`
      : '';
  lines.push(`${report.killed}/${report.sampled} mutants killed${scope}.`);
  // Rendered unconditionally, zero included: a timeout is a mutant this run
  // did not verify, and it is absent from the numerator above. Printing it
  // only when non-zero would let a reader assume a clean run had none.
  lines.push(`${report.timeout} mutant(s) timed out (not counted as killed).`);
  if (report.survived > 0) {
    lines.push('', `${report.survived} survived:`);
    for (const finding of report.findings.filter(
      (f) => f.status === 'survived',
    )) {
      const covering =
        finding.coveredBy.length > 0
          ? finding.coveredBy.join('; ')
          : 'no covering test';
      lines.push(
        `- \`${finding.path}:${finding.line}\` ${finding.mutator} ` +
          `${'\u{2192}'} \`${finding.replacement}\` ${'\u{2014}'} ran but did ` +
          `not fail: ${covering}`,
      );
    }
  }
  if (report.noCoverage > 0) {
    lines.push('', `${report.noCoverage} mutant(s) had no covering test.`);
  }
  lines.push(...suppressionLines(report));
  lines.push('', excludedLine(report));
  return lines.join('\n');
}
