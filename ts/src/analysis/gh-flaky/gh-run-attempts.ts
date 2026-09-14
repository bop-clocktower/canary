/**
 * Flake signals that survive an in-place Re-run (#884): `same-sha-flip` and
 * `rerun-attempt` (earlier attempts read from `/actions/runs/{id}/attempts/{n}`).
 * Never a zero without naming its signatures; gh only via {@link SubprocessRun}.
 */
import type { SubprocessRun } from '../../core/workflow-discovery.js';
import { EXIT_ABSTAINED, gateOutcome } from '../../core/gate-result.js';

/** Default window, stated explicitly: gh's own default is silent about it. */
export const GH_FLAKY_RUN_LIMIT = 100;
const GH_TIMEOUT_SECONDS = 30;

/** Conclusions that are not a completed outcome ("" is still in progress). */
const NON_OUTCOME_NAMES = 'action_required neutral skipped stale';
const NON_OUTCOMES = new Set(['', ...NON_OUTCOME_NAMES.split(' ')]);
const isOutcome = (c: string | null): c is string =>
  c !== null && !NON_OUTCOMES.has(c);

type Signature = 'same-sha-flip' | 'rerun-attempt';
const SIGNATURES: Signature[] = ['same-sha-flip', 'rerun-attempt'];
const label = (s: Signature) => (s === 'same-sha-flip' ? 'same-SHA flip' : s);

type Verdict =
  'candidates' | 'verified-zero' | 'flake-signal-unverifiable' | 'abstained';

interface RunRow {
  id: number;
  headSha: string;
  workflow: string;
  conclusion: string | null;
  attempt: number | null;
}

interface Candidate {
  signature: Signature;
  headSha: string;
  workflow: string;
  runId?: number;
  earlierConclusion?: string;
  conclusions?: string[];
}

interface Unverifiable {
  runId: number;
  attempt: number;
  source: string;
  reason: string;
}

interface RerunRead {
  candidates: Candidate[];
  unverifiable: Unverifiable[];
  nonOutcome: number;
}

interface GhFlakyReport {
  repo: string;
  verdict: Verdict;
  runsChecked: number;
  verifiedAgainst: Signature[];
  candidates: Candidate[];
  unverifiable: Unverifiable[];
  complete: boolean;
  window: string;
  skippedRows: number;
  missingAttemptRows: number;
  nonOutcomeRows: number;
  notes: string[];
  reason?: string;
}

function ghJson(run: SubprocessRun, cmd: string[]): unknown {
  const result = run(cmd, { timeout: GH_TIMEOUT_SECONDS });
  if (result.returncode !== 0) {
    throw new Error(`exit ${result.returncode}: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout) as unknown;
}

function toRunRow(raw: unknown): RunRow | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (typeof r.databaseId !== 'number' || typeof r.headSha !== 'string') {
    return null;
  }
  return {
    id: r.databaseId,
    headSha: r.headSha,
    workflow: typeof r.workflowName === 'string' ? r.workflowName : '',
    conclusion: typeof r.conclusion === 'string' ? r.conclusion : null,
    // Never defaulted to 1: that would verify a rerun signature never read.
    attempt: typeof r.attempt === 'number' ? r.attempt : null,
  };
}

function listRuns(
  repo: string,
  limit: number,
  run: SubprocessRun,
): { rows: RunRow[]; rawCount: number } {
  const cmd = ['gh', 'run', 'list', '--repo', repo, '--limit', String(limit)];
  cmd.push('--json', 'databaseId,headSha,workflowName,conclusion,attempt');
  const parsed = ghJson(run, cmd);
  if (!Array.isArray(parsed)) throw new Error('output was not a list');
  const rows = parsed.map(toRunRow).filter((r): r is RunRow => r !== null);
  return { rows, rawCount: parsed.length };
}

function sameShaFlips(rows: RunRow[]): Candidate[] {
  const groups = new Map<string, string[]>();
  for (const { workflow, headSha, conclusion } of rows) {
    if (!isOutcome(conclusion)) continue;
    const key = JSON.stringify([workflow, headSha]);
    groups.set(key, [...(groups.get(key) ?? []), conclusion]);
  }
  const flips: Candidate[] = [];
  for (const [key, all] of groups) {
    const conclusions = [...new Set(all)];
    if (!conclusions.includes('success') || conclusions.length < 2) continue;
    const [workflow, headSha] = JSON.parse(key) as [string, string];
    flips.push({ signature: 'same-sha-flip', headSha, workflow, conclusions });
  }
  return flips;
}

/** Read every earlier attempt of every green rerun. */
function rerunSignals(
  repo: string,
  rows: RunRow[],
  run: SubprocessRun,
): RerunRead {
  const read: RerunRead = { candidates: [], unverifiable: [], nonOutcome: 0 };
  for (const row of rows) {
    if (row.conclusion !== 'success') continue;
    for (let n = 1; n < (row.attempt ?? 1); n++) {
      readAttempt(repo, row, n, run, read);
    }
  }
  return read;
}

function readAttempt(
  repo: string,
  row: RunRow,
  attempt: number,
  run: SubprocessRun,
  read: RerunRead,
): void {
  const source = `/repos/${repo}/actions/runs/${row.id}/attempts/${attempt}`;
  try {
    const body = ghJson(run, ['gh', 'api', source.slice(1)]) as {
      conclusion?: unknown;
    };
    const c = typeof body?.conclusion === 'string' ? body.conclusion : null;
    if (!isOutcome(c)) read.nonOutcome++;
    if (!isOutcome(c) || c === 'success') return;
    const { headSha, workflow, id: runId } = row;
    const hit = { headSha, workflow, runId, earlierConclusion: c };
    read.candidates.push({ signature: 'rerun-attempt', ...hit });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    read.unverifiable.push({ runId: row.id, attempt, source, reason });
  }
}

function abstained(repo: string, reason: string): GhFlakyReport {
  return {
    repo,
    verdict: 'abstained',
    runsChecked: 0,
    verifiedAgainst: [],
    candidates: [],
    unverifiable: [],
    complete: false,
    window: 'no runs read',
    skippedRows: 0,
    missingAttemptRows: 0,
    nonOutcomeRows: 0,
    notes: [],
    reason,
  };
}

function verdictOf(candidates: number, unverified: number): Verdict {
  if (candidates > 0) return 'candidates';
  return unverified > 0 ? 'flake-signal-unverifiable' : 'verified-zero';
}

/** Every disclosure, in words, for both the text and JSON output. */
function notesFor(r: GhFlakyReport): string[] {
  const kinds = `in progress, ${NON_OUTCOME_NAMES.split(' ').join(', ')}`;
  const notes: [number, string][] = [
    [r.complete ? 0 : 1, r.window],
    [
      r.skippedRows,
      `${r.skippedRows} malformed run row(s) from gh skipped; not checked`,
    ],
    [
      r.missingAttemptRows,
      `${r.missingAttemptRows} run row(s) carried no attempt number; rerun-attempt not verified`,
    ],
    [
      r.nonOutcomeRows,
      `${r.nonOutcomeRows} run row(s) had no completed outcome (${kinds}); never a flip or rerun candidate`,
    ],
  ];
  return notes.filter(([n]) => n > 0).map(([, text]) => text);
}

/** Scan the last `limit` runs of `repo` for both flake signatures. */
export function scanGhFlaky(
  repo: string,
  limit: number,
  run: SubprocessRun,
): GhFlakyReport {
  let rows: RunRow[];
  let rawCount: number;
  try {
    ({ rows, rawCount } = listRuns(repo, limit, run));
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return abstained(repo, `gh run list could not be read (${why}).`);
  }
  if (rows.length === 0) {
    return abstained(repo, 'gh run list returned zero runs.');
  }
  const reruns = rerunSignals(repo, rows, run);
  const candidates = [...sameShaFlips(rows), ...reruns.candidates];
  const missingAttemptRows = rows.filter((r) => r.attempt === null).length;
  const unverified = reruns.unverifiable.length + missingAttemptRows;
  const nonOutcomeRows =
    rows.filter((r) => !isOutcome(r.conclusion)).length + reruns.nonOutcome;
  const complete = rawCount < limit; // disclosed; the verdict covers the window
  const report: GhFlakyReport = {
    repo,
    verdict: verdictOf(candidates.length, unverified),
    runsChecked: rows.length,
    verifiedAgainst: SIGNATURES.slice(0, unverified > 0 ? 1 : 2),
    candidates,
    unverifiable: reruns.unverifiable,
    complete,
    window: complete
      ? `window complete: all ${rows.length} runs checked`
      : `window truncated at ${limit} runs; older runs unchecked`,
    skippedRows: rawCount - rows.length,
    missingAttemptRows,
    nonOutcomeRows,
    notes: [],
  };
  report.notes = notesFor(report);
  return report;
}

function describeCandidate(c: Candidate): string {
  if (c.signature === 'rerun-attempt') {
    return (
      `  rerun-attempt  run ${c.runId} (${c.workflow} @ ${c.headSha}): ` +
      `an earlier attempt concluded ${c.earlierConclusion}, re-run to success`
    );
  }
  return (
    `  same-SHA flip  ${c.workflow} @ ${c.headSha}: ` +
    `${(c.conclusions ?? []).join(' / ')}`
  );
}

/** Human-readable report. Never prints a zero without its signatures. */
export function renderGhFlaky(report: GhFlakyReport): string[] {
  if (report.verdict === 'abstained') {
    const { summaryLine } = gateOutcome({ checked: 0, findings: [] }, 'gate');
    return [`${summaryLine} gh-flaky for ${report.repo}: ${report.reason}`];
  }
  const lines = [`gh-flaky ${report.repo}: ${report.verdict}`];
  lines.push(...report.candidates.map(describeCandidate));
  for (const u of report.unverifiable) {
    lines.push(`  unverifiable   run ${u.runId}: ${u.source} (${u.reason})`);
  }
  if (report.verdict === 'flake-signal-unverifiable') {
    lines.push('flake-signal-unverifiable: rerun-attempt is NOT verified.');
  } else if (report.verdict === 'verified-zero') {
    lines.push('0 candidates.');
  }
  const names = report.verifiedAgainst.map(label).join(', ');
  lines.push(`Verified against: ${names} (${report.runsChecked} runs).`);
  lines.push(...report.notes.map((n) => `Note: ${n}.`));
  return lines;
}

/** Gate contract: 0 verified zero, 1 candidates, 3 abstained or unverifiable. */
export function ghFlakyExitCode(report: GhFlakyReport): number {
  if (report.verdict === 'verified-zero') return 0;
  return report.verdict === 'candidates' ? 1 : EXIT_ABSTAINED;
}
