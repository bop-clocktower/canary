/**
 * Diff-scoped mutation testing (#486), tool-independent core.
 *
 * Coverage proves a test RAN. A mutation proves a test would FAIL if the code
 * were wrong. This module turns guardian's existing diff scope into Stryker
 * `mutate` entries, and turns Stryker's JSON report back into a guardian-shaped
 * verdict with abstention and suppression rules.
 *
 * WHY THE RUN ITSELF IS NOT HERE. The 2026-09-17 spike found that
 * `@stryker-mutator/vitest-runner` 10.0.0 cannot kill mutants on vitest 5: it
 * builds vitest's `testNamePattern` by joining describe/test names with a
 * space, vitest 5 matches on `' > '`, so every mutant run executes zero tests
 * and every covered mutant reports "Survived" (upstream stryker-js#6210). A
 * check that prints confident false survivors is worse than no check, so
 * {@link runnerCompatibility} gates the run and the caller abstains. Fork F6 on
 * issue #486 recorded that decision.
 *
 * The second spike finding shapes {@link threadUnsafeTests}: the runner forces
 * `pool: 'threads'` and `process.chdir()` does not exist in a worker thread, so
 * every suite that changes directory has to be excluded from a mutation run. A
 * mutant only an excluded suite would kill therefore reads as `survived` -- a
 * false survivor by construction. Every report discloses that list, because a
 * precision number quoted without it would be a number about nothing.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import type { ChangedUnit } from './diff-coverage/types.js';

/** Only paths vitest's coverage `include: ['src/**']` can attribute (F3). */
const MUTATE_PREFIX = 'ts/src/';

/** Test paths are never mutated: a test does not itself need a test. */
const TEST_PATH_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** D7: the per-PR mutant budget. Over it, the run samples and says so. */
export const MUTANT_CAP = 150;

/** The upstream bug that makes a vitest-5 mutation run untrustworthy. */
export const RUNNER_ISSUE = 'stryker-js#6210';

/**
 * The newest `@stryker-mutator/vitest-runner` known to carry the #6210
 * name-join bug. Anything strictly newer is assumed fixed; revising this is a
 * one-line change plus its test, which is why it is data rather than a branch.
 */
export const BROKEN_RUNNER_MAX = '10.0.0';

/** The first vitest major whose per-test name filter joins names with ' > '. */
export const FIRST_AFFECTED_VITEST_MAJOR = 5;

/** Markers identifying a suite that cannot run inside a worker thread. */
const THREAD_UNSAFE_MARKERS = [
  'process.chdir',
  'guardian-cli-testkit',
  'canary-cli-testkit',
];

const SUPPRESS_MUTANT_RE = /(?:\/\/|#)\s*canary:allow-mutant\s+(.+)/;

/** How a mutant ended up, in guardian's vocabulary rather than Stryker's. */
export type MutationStatus = 'killed' | 'survived' | 'no-coverage' | 'timeout';

/** The overall answer. `abstained` is never a pass and never a failure. */
export type MutationVerdict = 'survivors' | 'all-killed' | 'abstained';

/** One mutant, and the tests that ran over it without noticing. */
export interface MutantFinding {
  path: string;
  line: number;
  /** Stryker's mutator name, e.g. `ConditionalExpression`. */
  mutator: string;
  /** The mutated source snippet. */
  replacement: string;
  status: MutationStatus;
  /** Test names that covered the mutant but did not fail. */
  coveredBy: string[];
}

/** A survivor the author accepted in writing, with the reason they gave. */
export interface SuppressedMutant {
  finding: MutantFinding;
  reason: string;
}

/** The guardian-shaped verdict for one mutation run. */
export interface MutationReport {
  verdict: MutationVerdict;
  abstainReason?: string;
  /** Mutants Stryker generated, before the D7 cap. */
  generated: number;
  /** Mutants actually run. Equal to `generated` unless the cap truncated. */
  sampled: number;
  killed: number;
  survived: number;
  /** Reported apart from survivors: a coverage gap, not a weak assertion. */
  noCoverage: number;
  timeout: number;
  findings: MutantFinding[];
  suppressed: SuppressedMutant[];
  /**
   * Suites excluded from the run because they cannot run in a worker thread.
   * Disclosed on EVERY report, abstentions included -- a survivor count read
   * without this list overstates what the run actually checked.
   */
  excludedTests: string[];
}

/** The subset of Stryker's JSON report schema this module consumes. */
export interface StrykerReport {
  schemaVersion?: string;
  files: Record<
    string,
    {
      language?: string;
      source?: string;
      mutants: Array<{
        id: string;
        mutatorName: string;
        replacement?: string;
        status: string;
        location: { start: { line: number; column: number } };
        coveredBy?: string[];
      }>;
    }
  >;
  testFiles?: Record<string, { tests: Array<{ id: string; name: string }> }>;
}

/** Whether the installed runner can be trusted to kill a mutant at all. */
export interface RunnerVerdict {
  compatible: boolean;
  reason?: string;
}

/** Options for {@link mapStrykerReport}. */
export interface MapOptions {
  excludedTests: string[];
  /** Pre-cap mutant count, when the caller sampled before running (D7). */
  generated?: number;
}

/**
 * Turn guardian's filtered diff scope into Stryker `mutate` entries.
 *
 * The caller passes the units guardian already kept -- skip globs, test files,
 * test support and type-only modules filtered out -- so there is exactly one
 * definition of "what this PR changed" (D2). The prefix and test-path guards
 * here are a floor, not a substitute for those filters.
 */
export function mutateEntries(units: ChangedUnit[]): string[] {
  const entries: string[] = [];
  for (const unit of units) {
    if (!unit.path.startsWith(MUTATE_PREFIX)) continue;
    if (TEST_PATH_RE.test(unit.path)) continue;
    for (const [start, end] of unit.added_ranges) {
      entries.push(`${unit.path}:${start}-${end}`);
    }
  }
  return entries;
}

/** The outcome of applying the D7 cap. */
export interface SampleResult<T> {
  sampled: T[];
  generated: number;
}

/**
 * Cap a mutant list deterministically, by (path, line, mutator).
 *
 * F4: a partial result that states its denominator beats silence, so the caller
 * reports `sampled N of M` rather than pretending it ran everything. The sort
 * makes two runs over the same diff pick the same mutants, which is what lets a
 * survivor be re-checked after a fix.
 */
export function sampleMutants<
  T extends { path: string; line: number; mutator: string },
>(mutants: T[], cap: number = MUTANT_CAP): SampleResult<T> {
  const ordered = [...mutants].sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.line - b.line ||
      a.mutator.localeCompare(b.mutator),
  );
  return { sampled: ordered.slice(0, cap), generated: mutants.length };
}

/** Parse a leading `major.minor.patch`; `null` when it is not one. */
function parseVersion(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** `a > b` over parsed semver triples. */
function isNewer(a: [number, number, number], b: [number, number, number]) {
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return false;
}

/**
 * Decide whether a mutation run could produce a verdict worth reading.
 *
 * This is the guard that keeps #6210 from becoming a false green in reverse: an
 * incompatible pairing must abstain, because the runner reports every covered
 * mutant as "Survived" while running zero tests. An unknown version is
 * incompatible too -- guessing here is exactly the abstention this issue exists
 * to prevent.
 */
export function runnerCompatibility(
  runnerVersion: string | null,
  vitestVersion: string | null,
): RunnerVerdict {
  if (runnerVersion === null) {
    return {
      compatible: false,
      reason:
        '@stryker-mutator/vitest-runner is not installed, so no mutant was run',
    };
  }
  const runner = parseVersion(runnerVersion);
  const vitest = vitestVersion === null ? null : parseVersion(vitestVersion);
  if (runner === null || vitest === null) {
    return {
      compatible: false,
      reason:
        `cannot read the runner/vitest versions ` +
        `(runner ${runnerVersion}, vitest ${vitestVersion ?? 'unknown'})`,
    };
  }
  if (vitest[0] < FIRST_AFFECTED_VITEST_MAJOR) return { compatible: true };
  if (isNewer(runner, parseVersion(BROKEN_RUNNER_MAX)!)) {
    return { compatible: true };
  }
  return {
    compatible: false,
    reason:
      `@stryker-mutator/vitest-runner ${runnerVersion} runs zero tests per ` +
      `mutant on vitest ${vitestVersion}, so every covered mutant would be ` +
      `reported as survived (${RUNNER_ISSUE})`,
  };
}

/** An abstention: a reason, a zero denominator, and no findings. Ever. */
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
  if (report.killed === 0 && report.survived === 0 && report.timeout === 0) {
    return {
      verdict: 'abstained',
      abstainReason:
        'no mutant was covered by any test, so nothing could be killed',
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

/** Recursively list `*.test.ts` files under `dir`. */
function listTests(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listTests(full));
    else if (entry.name.endsWith('.test.ts')) found.push(full);
  }
  return found;
}

/**
 * List the suites a Stryker run has to exclude, repo-relative to `root`.
 *
 * Stryker's vitest runner forces `pool: 'threads'`, and `process.chdir()` does
 * not exist in a worker thread, so any suite that changes directory -- directly
 * or through a CLI testkit -- fails the initial run and Stryker then refuses to
 * mutate anything. This list is what the report discloses (F6).
 */
export function threadUnsafeTests(root: string): string[] {
  const files = [
    ...listTests(join(root, 'src')),
    ...listTests(join(root, 'test')),
  ];
  return files
    .filter((file) => {
      let text;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        return false;
      }
      return THREAD_UNSAFE_MARKERS.some((marker) => text.includes(marker));
    })
    .map((file) => relative(root, file).split(sep).join('/'))
    .sort();
}
