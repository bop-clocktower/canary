/**
 * Flake signals from GitHub Actions run history that survive an in-place
 * Re-run (#884).
 *
 * GitHub's Re-run does not add a run record. It bumps `run_attempt` and
 * REPLACES the run's conclusion, so a run that failed and was re-run to green
 * leaves one row reading `success`. A scan keyed only on the same-SHA outcome
 * flip (one sha, one workflow, a success and a failure) reads that row and
 * reports "0 candidates" whether flakes exist or not.
 *
 * So this reads two signatures and never reports a zero without naming the
 * signatures it was verified against:
 *   - `same-sha-flip`: two runs of one workflow on one sha that disagree.
 *   - `rerun-attempt`: a run on attempt > 1 that is green now, but whose
 *     earlier attempt, read from `/actions/runs/{id}/attempts/{n}`, was not.
 *
 * An earlier attempt that cannot be read is recorded as unverifiable with the
 * endpoint named. It is never folded into a zero.
 *
 * gh is reached only through the injected {@link SubprocessRun} seam that
 * `batwoman/gh-history.ts` uses, so the classification stays pure and tests
 * never shell out.
 */
import type { SubprocessRun } from '../core/workflow-discovery.js';
import { EXIT_ABSTAINED, gateOutcome } from '../core/gate-result.js';

/** Default window, stated explicitly: gh's own default is silent about it. */
export const GH_FLAKY_RUN_LIMIT = 100;

const GH_TIMEOUT_SECONDS = 30;

type Signature = 'same-sha-flip' | 'rerun-attempt';

type Verdict =
  'candidates' | 'verified-zero' | 'flake-signal-unverifiable' | 'abstained';

interface RunRow {
  id: number;
  headSha: string;
  workflow: string;
  conclusion: string | null;
  attempt: number;
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

interface GhFlakyReport {
  repo: string;
  verdict: Verdict;
  runsChecked: number;
  verifiedAgainst: Signature[];
  candidates: Candidate[];
  unverifiable: Unverifiable[];
  reason?: string;
}

const SIGNATURE_LABEL: Record<Signature, string> = {
  'same-sha-flip': 'same-SHA flip',
  'rerun-attempt': 'rerun-attempt',
};

/** Run one gh call and parse its JSON, throwing on anything but a clean answer. */
function ghJson(run: SubprocessRun, cmd: string[]): unknown {
  const result = run(cmd, { timeout: GH_TIMEOUT_SECONDS });
  if (result.returncode !== 0) {
    throw new Error(
      `exit ${result.returncode}: ${result.stderr.trim() || 'no stderr'}`,
    );
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
    attempt: typeof r.attempt === 'number' ? r.attempt : 1,
  };
}

function listRuns(repo: string, limit: number, run: SubprocessRun): RunRow[] {
  const cmd = ['gh', 'run', 'list', '--repo', repo, '--limit', String(limit)];
  cmd.push('--json', 'databaseId,headSha,workflowName,conclusion,attempt');
  const parsed = ghJson(run, cmd);
  if (!Array.isArray(parsed)) throw new Error('output was not a list');
  return parsed.map(toRunRow).filter((r): r is RunRow => r !== null);
}

/** A sha + workflow group holding both a success and a non-success outcome. */
function sameShaFlips(rows: RunRow[]): Candidate[] {
  const groups = new Map<string, RunRow[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.workflow, row.headSha]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const flips: Candidate[] = [];
  for (const group of groups.values()) {
    const conclusions = [...new Set(group.map((r) => r.conclusion ?? 'null'))];
    if (conclusions.includes('success') && conclusions.length > 1) {
      const { headSha, workflow } = group[0]!;
      flips.push({
        signature: 'same-sha-flip',
        headSha,
        workflow,
        conclusions,
      });
    }
  }
  return flips;
}

/** Read every earlier attempt of one green rerun. */
function readEarlierAttempts(
  repo: string,
  row: RunRow,
  run: SubprocessRun,
): { candidates: Candidate[]; unverifiable: Unverifiable[] } {
  const candidates: Candidate[] = [];
  const unverifiable: Unverifiable[] = [];
  for (let attempt = 1; attempt < row.attempt; attempt++) {
    const path = `repos/${repo}/actions/runs/${row.id}/attempts/${attempt}`;
    try {
      const body = ghJson(run, ['gh', 'api', path]) as { conclusion?: unknown };
      const earlier = String(body?.conclusion ?? 'null');
      if (earlier === 'success') continue;
      const { headSha, workflow, id: runId } = row;
      candidates.push({
        signature: 'rerun-attempt',
        headSha,
        workflow,
        runId,
        earlierConclusion: earlier,
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      unverifiable.push({ runId: row.id, attempt, source: `/${path}`, reason });
    }
  }
  return { candidates, unverifiable };
}

function abstained(repo: string, reason: string): GhFlakyReport {
  return {
    repo,
    verdict: 'abstained',
    runsChecked: 0,
    verifiedAgainst: [],
    candidates: [],
    unverifiable: [],
    reason,
  };
}

function verdictOf(candidates: number, unverifiable: number): Verdict {
  if (candidates > 0) return 'candidates';
  return unverifiable > 0 ? 'flake-signal-unverifiable' : 'verified-zero';
}

/** Scan the last `limit` runs of `repo` for both flake signatures. */
export function scanGhFlaky(
  repo: string,
  limit: number,
  run: SubprocessRun,
): GhFlakyReport {
  let rows: RunRow[];
  try {
    rows = listRuns(repo, limit, run);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return abstained(repo, `gh run list could not be read (${why}).`);
  }
  if (rows.length === 0) {
    return abstained(repo, 'gh run list returned zero runs.');
  }
  const candidates = sameShaFlips(rows);
  const unverifiable: Unverifiable[] = [];
  for (const row of rows) {
    if (row.attempt <= 1 || row.conclusion !== 'success') continue;
    const read = readEarlierAttempts(repo, row, run);
    candidates.push(...read.candidates);
    unverifiable.push(...read.unverifiable);
  }
  const verifiedAgainst: Signature[] = ['same-sha-flip'];
  if (unverifiable.length === 0) verifiedAgainst.push('rerun-attempt');
  return {
    repo,
    verdict: verdictOf(candidates.length, unverifiable.length),
    runsChecked: rows.length,
    verifiedAgainst,
    candidates,
    unverifiable,
  };
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

function verifiedLine(report: GhFlakyReport): string {
  const names = report.verifiedAgainst.map((s) => SIGNATURE_LABEL[s]);
  return `Verified against: ${names.join(', ')} (${report.runsChecked} runs).`;
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
    lines.push(
      `  unverifiable   run ${u.runId} attempt ${u.attempt}: ` +
        `could not read ${u.source} (${u.reason})`,
    );
  }
  if (report.verdict === 'flake-signal-unverifiable') {
    lines.push(
      'flake-signal-unverifiable: the rerun-attempt signature is NOT ' +
        'verified, so no zero is reported for it.',
    );
  } else if (report.verdict === 'verified-zero') {
    lines.push('0 candidates.');
  }
  lines.push(verifiedLine(report));
  return lines;
}

/** Gate contract: 0 verified zero, 1 candidates, 3 abstained or unverifiable. */
export function ghFlakyExitCode(report: GhFlakyReport): number {
  if (report.verdict === 'verified-zero') return 0;
  return report.verdict === 'candidates' ? 1 : EXIT_ABSTAINED;
}
