/**
 * Passive adoption signals (#491), computed from guardian analysis records.
 *
 * The people who stopped trusting canary do nothing, so the honest signals are
 * the ones that need no cooperation: did PRs merge over unaddressed findings,
 * does anyone suppress, is the gate ever promoted, how often does a run
 * degrade, how loud is the average PR.
 *
 * Every signal carries its denominator. A signal with nothing to count is
 * `abstained`, never a zero: "0 of 0 merged PRs ignored findings" reads as
 * healthy and says nothing. Pure module: no I/O, no network.
 */

/** The subset of an analysis record (schema >= 1.0) this report reads. */
export interface GuardianRecord {
  ref: string;
  gate: string;
  tier: number;
  abstained: boolean;
  degradedNotice: string | null;
  analyzedAt: string;
  summary: { total: number; unaddressed: number; suppressed: number };
}

/**
 * `unresolved` is a PR whose merge marker is absent (open, or rebase-merged);
 * `unknown` is a PR git could not be asked about; `not-a-pr` is a ref that
 * could never carry a merge state (a short SHA, `local`). They are kept apart
 * so a reader is never invited to read one as the other.
 */
export type MergeState = 'merged' | 'unresolved' | 'unknown' | 'not-a-pr';

export type Measured<T> =
  | { status: 'measured'; denominator: number; value: T }
  | { status: 'abstained'; denominator: 0; reason: string }
  | { status: 'not-measured'; reason: string };

export interface RecordSignals {
  mergedWithUnaddressed: Measured<{
    merged: number;
    withUnaddressed: number;
    unresolved: number;
    notAPr: number;
  }>;
  suppression: Measured<{
    findings: number;
    suppressed: number;
    recordsWithSuppression: number;
  }>;
  gate: Measured<{ byGate: Record<string, number>; latest: string }>;
  degradation: Measured<{
    degraded: number;
    abstained: number;
    byTier: Record<string, number>;
  }>;
  findingsPerPr: Measured<{
    min: number;
    median: number;
    p90: number;
    max: number;
    over100: number;
  }>;
}

const NO_RECORDS = 'no guardian records to read';

function abstain(reason: string): {
  status: 'abstained';
  denominator: 0;
  reason: string;
} {
  return { status: 'abstained', denominator: 0, reason };
}

/** `analyzedAt` as an epoch ms; an unparseable stamp sorts oldest. */
function instant(stamp: string): number {
  const ms = Date.parse(stamp);
  return Number.isNaN(ms) ? -Infinity : ms;
}

// Integer-like keys are enumerated numerically by the language, so the tier
// tally needs no sort of its own; the sort here is for the non-numeric keys.
function tally(keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of [...keys].sort()) out[k] = (out[k] ?? 0) + 1;
  return out;
}

/** Nearest-rank percentile over an ascending array. */
function rank(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0;
}

function countState(
  records: GuardianRecord[],
  merge: ReadonlyMap<string, MergeState>,
  state: MergeState,
): number {
  return records.filter((r) => merge.get(r.ref) === state).length;
}

function mergeSignal(
  records: GuardianRecord[],
  merge: ReadonlyMap<string, MergeState>,
  gitProblem: string | null,
): RecordSignals['mergedWithUnaddressed'] {
  if (gitProblem !== null) {
    // Could not look. That is a finding, not an abstention with a reason about
    // the branch that was never established.
    return { status: 'not-measured', reason: gitProblem };
  }
  const merged = records.filter((r) => merge.get(r.ref) === 'merged');
  if (merged.length === 0) {
    return abstain(
      records.length === 0
        ? NO_RECORDS
        : 'no record resolved as merged on the branch',
    );
  }
  return {
    status: 'measured',
    denominator: merged.length,
    value: {
      merged: merged.length,
      withUnaddressed: merged.filter((r) => r.summary.unaddressed > 0).length,
      unresolved: countState(records, merge, 'unresolved'),
      notAPr: countState(records, merge, 'not-a-pr'),
    },
  };
}

function suppressionSignal(
  records: GuardianRecord[],
  noRecordsReason: string,
): RecordSignals['suppression'] {
  const findings = records.reduce((n, r) => n + r.summary.total, 0);
  if (findings === 0) {
    return abstain(
      records.length === 0 ? noRecordsReason : 'records carry zero findings',
    );
  }
  return {
    status: 'measured',
    denominator: findings,
    value: {
      findings,
      suppressed: records.reduce((n, r) => n + r.summary.suppressed, 0),
      recordsWithSuppression: records.filter((r) => r.summary.suppressed > 0)
        .length,
    },
  };
}

function findingsSignal(
  records: GuardianRecord[],
): RecordSignals['findingsPerPr'] {
  const totals = records.map((r) => r.summary.total).sort((a, b) => a - b);
  return {
    status: 'measured',
    denominator: totals.length,
    value: {
      min: totals[0] ?? 0,
      median: rank(totals, 0.5),
      p90: rank(totals, 0.9),
      max: totals[totals.length - 1] ?? 0,
      over100: totals.filter((t) => t > 100).length,
    },
  };
}

/** Compute every record-derived signal. */
export function computeSignals(
  records: GuardianRecord[],
  merge: ReadonlyMap<string, MergeState>,
  gitProblem: string | null = null,
  // Why there were no records, when that is known (a missing or unreadable
  // directory). Carried into every abstention reason so a per-signal line is
  // never less informative than the header.
  dirProblem: string | null = null,
): RecordSignals {
  if (records.length === 0) {
    const reason = dirProblem ?? NO_RECORDS;
    return {
      mergedWithUnaddressed:
        gitProblem === null
          ? abstain(reason)
          : { status: 'not-measured', reason: gitProblem },
      suppression: abstain(reason),
      gate: abstain(reason),
      degradation: abstain(reason),
      findingsPerPr: abstain(reason),
    };
  }
  // Compared as instants, not strings: two records written at the same moment
  // with different UTC offsets would order wrongly under string collation.
  const latest = [...records].sort(
    (a, b) => instant(b.analyzedAt) - instant(a.analyzedAt),
  )[0] as GuardianRecord;
  return {
    mergedWithUnaddressed: mergeSignal(records, merge, gitProblem),
    suppression: suppressionSignal(records, NO_RECORDS),
    gate: {
      status: 'measured',
      denominator: records.length,
      value: { byGate: tally(records.map((r) => r.gate)), latest: latest.gate },
    },
    degradation: {
      status: 'measured',
      denominator: records.length,
      value: {
        degraded: records.filter((r) => r.degradedNotice !== null).length,
        abstained: records.filter((r) => r.abstained).length,
        byTier: tally(records.map((r) => String(r.tier))),
      },
    },
    findingsPerPr: findingsSignal(records),
  };
}
