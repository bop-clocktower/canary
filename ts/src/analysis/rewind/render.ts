/**
 * `canary rewind` output (#461 PR 2). The text form and `--json` are built
 * from one report object so they cannot disagree. Neither carries a pass/fail
 * field: the outcome is a finding about a past failure, not a gate.
 */

import type { RunRecord, TestResultRecord } from '../../history/record.js';
import { def } from '../../util/coalesce.js';
import type { FidelityRow, ReplayOutcome } from './plan.js';

export interface RewindReport {
  runId: string;
  test: string;
  commit: string;
  fidelity: FidelityRow[];
  attempts: number;
  statuses: string[];
  outcome: ReplayOutcome | 'not-run';
  recorded: TestResultRecord;
  green: { run: RunRecord; distance: number } | null;
}

const FLAKY_HANDOFF =
  'Intermittent: hand off to `canary history flaky` for its flake rate, or ' +
  'the canary-flake-hunter agent to diagnose it. Rewind does not decide flakiness.';

export function renderRewind(report: RewindReport, json: boolean): string {
  return json ? JSON.stringify(toJson(report), null, 2) : toText(report);
}

function greenTest(report: RewindReport): TestResultRecord | undefined {
  return report.green?.run.tests?.find((t) => t.test_name === report.test);
}

function toJson(report: RewindReport): Record<string, unknown> {
  return {
    run_id: report.runId,
    test: report.test,
    commit: report.commit,
    fidelity: report.fidelity,
    attempts: report.attempts,
    statuses: report.statuses,
    outcome: report.outcome,
    nearestGreen: greenJson(report),
    recorded: {
      error_text: def(report.recorded.error_text, null),
      duration_ms: def(report.recorded.duration_ms, null),
    },
  };
}

function greenJson(report: RewindReport): Record<string, unknown> | null {
  const green = report.green;
  if (green === null) return null;
  return {
    run_id: green.run.run_id,
    commit: def(green.run.commit_sha, null),
    distance: green.distance,
    duration_ms: def(greenTest(report)?.duration_ms, null),
  };
}

function toText(report: RewindReport): string {
  const lines = [
    `Rewind ${report.runId} \u{00B7} ${report.test}`,
    '',
    'Fidelity:',
    ...report.fidelity.map(
      (r) => `  ${r.dimension.padEnd(12)} ${r.status.padEnd(13)} ${r.reason}`,
    ),
    '',
    resultLine(report),
    ...greenLines(report),
  ];
  if (report.outcome === 'intermittent') lines.push('', FLAKY_HANDOFF);
  return lines.join('\n');
}

function resultLine(report: RewindReport): string {
  if (report.outcome === 'not-run') {
    return (
      `Result: not-run (no attempt ran the test; statuses: ` +
      `${report.statuses.join(', ') || 'none reported'}; see the environment row)`
    );
  }
  const ran = report.statuses.filter((s) => s !== 'skipped' && s !== 'pending');
  const failed = ran.filter((s) => s !== 'passed').length;
  return `Result: ${report.outcome} (${failed} of ${ran.length} attempts failed)`;
}

function greenLines(report: RewindReport): string[] {
  const green = report.green;
  if (green === null) {
    return ['Nearest green: none recorded on first-parent history'];
  }
  const sha = def(green.run.commit_sha, '').slice(0, 12);
  const then = report.recorded;
  const error = def(then.error_text, '(none recorded)').split('\n')[0];
  return [
    `Nearest green: ${green.run.run_id} at ${sha} (${green.distance} commit(s) back)`,
    `  commits: ${sha}..${report.commit.slice(0, 12)}`,
    `  duration: ${ms(greenTest(report)?.duration_ms)} green -> ${ms(then.duration_ms)} failing`,
    `  error when failing: ${error}`,
  ];
}

function ms(value: number | null | undefined): string {
  return typeof value === 'number' ? `${value}ms` : 'unknown';
}
