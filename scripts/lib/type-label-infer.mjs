/**
 * Type-label inference for harness-managed issues (#880).
 *
 * Roadmap sync files issues with no type label (upstream
 * Intense-Visions/harness-engineering#2146), so roadmap-fleet's metadata
 * routing step never fires. This is deliberately a small keyword heuristic,
 * not a classifier: every inference carries a human-readable reason so a dry
 * run can be reviewed line by line before `--apply`.
 */

/** The repo's existing type vocabulary. Any one of these means "already typed". */
export const TYPE_LABELS = [
  'bug',
  'enhancement',
  'documentation',
  'chore',
  'question',
  'spike',
  'decision',
];

export const MANAGED_LABEL = 'harness-managed';

// Order matters: a bug that mentions docs is still a bug.
const RULES = [
  {
    label: 'bug',
    re: /\b(bug|defect|broken|crash(es|ed)?|regression|false[- ]green|fails?|failing|wrong|incorrect)\b/i,
  },
  {
    label: 'documentation',
    re: /^(docs?(\(|:)|documentation\b)/i,
  },
  {
    label: 'chore',
    re: /\b(chore|bump|upgrade|pin|cleanup|clean up|rename|dependenc(y|ies))\b/i,
  },
];

/** Infer one type label from an issue's title, then its body. */
export function inferTypeLabel({ title = '', body = '' }) {
  for (const [field, text] of [
    ['title', title],
    ['body', body ?? ''],
  ]) {
    for (const { label, re } of RULES) {
      const m = text.match(re);
      if (m) return { label, reason: `${field} matched "${m[0]}"` };
    }
  }
  return {
    label: 'enhancement',
    reason: 'no rule matched; default (roadmap-fleet safe default)',
  };
}

const labelNames = (issue) =>
  (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));

/**
 * `examined` counts harness-managed issues only, so a caller can tell an
 * all-typed backlog (examined > 0, empty plan) from a run that saw nothing.
 */
export function planBackfill(issues) {
  const managed = issues.filter((i) => labelNames(i).includes(MANAGED_LABEL));
  const plan = managed
    .filter((i) => !labelNames(i).some((n) => TYPE_LABELS.includes(n)))
    .map((i) => ({ number: i.number, title: i.title, ...inferTypeLabel(i) }));
  return { examined: managed.length, plan };
}
