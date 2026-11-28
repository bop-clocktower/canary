// derive -- labels that cost nobody a new habit (#618, ADR 0025).
//
// Three guardian rules, the same ones ts/src/guardian/adjudication.ts applies
// to sticky-comment edit history, applied here to recorded `pr-check --json`
// runs so the two can never disagree on what a signal means:
//
//   guardian-fp-suppression       suppressed, reason starts `fp:`  -> noise
//   guardian-reasoned-suppression suppressed, any other reason     -> intentional
//   guardian-covered-later        coverage-verified in the PR's first run,
//                                 absent from this vouching run, file still
//                                 in this run's diff                -> real
//
// Anything else is left unlabelled and counted: ambiguous (gone, but nothing
// vouches that it was covered) or unresolved (still there). Rejected and not
// built: "a later fix: commit touched the path" (see the spec -- it labels
// high-churn files real for unrelated reasons). Each derived label is written
// once per (finding, rule) and names the run it came from, so a person can
// audit it and override it with a later explicit label.

import { changedFiles } from './git.mjs';

const RULES = {
  fp: 'guardian-fp-suppression',
  reasoned: 'guardian-reasoned-suppression',
  coveredLater: 'guardian-covered-later',
};

// Mirrors suppressionKind() in ts/src/guardian/adjudication.ts.
const FP_PREFIX = /^fp\s*:/i;

function label(finding, outcome, rule, at, evidence) {
  return {
    v: 1,
    kind: 'label',
    finding,
    gate: 'guardian',
    outcome,
    rule,
    by: 'derived',
    at,
    evidence,
    note: null,
  };
}

/** Labels from this run's suppressions. */
function fromSuppressions(run, at) {
  const out = [];
  for (const f of run.findings) {
    if (!f.suppressed) continue;
    const reason = String(f.reason ?? '');
    const fp = FP_PREFIX.test(reason.trim());
    const evidence = `run ${run.run}: ${reason}`;
    out.push(
      fp
        ? label(f.id, 'noise', RULES.fp, at, evidence)
        : label(f.id, 'intentional', RULES.reasoned, at, evidence),
    );
  }
  return out;
}

/** The first earlier guardian run recorded for the same PR, if any. */
function firstRunOf(state, run) {
  if (run.pr === null || run.pr === undefined) return null;
  return (
    state.runs.find(
      (r) => r.gate === 'guardian' && r.pr === run.pr && r.run !== run.run,
    ) ?? null
  );
}

/** Classify one first-run finding against this (later) run. */
function judgeLater(entry, ctx) {
  const finding = ctx.state.findings.get(entry.id);
  if (ctx.present.has(entry.id)) return 'unresolved';
  if (entry.suppressed) return 'suppressed';
  if (finding?.fidelity !== 'coverage-verified' || !ctx.run.vouches) {
    return 'ambiguous';
  }
  const diff = ctx.diff();
  return diff.files?.has(finding.file) ? 'real' : 'ambiguous';
}

/** Labels from comparing the PR's first run with this one. */
function fromCoverage(state, run, at, changed) {
  const first = firstRunOf(state, run);
  const tally = { labels: [], ambiguous: 0, unresolved: 0 };
  if (!first) return tally;
  let diff = null;
  const ctx = {
    state,
    run,
    present: new Set(run.findings.map((f) => f.id)),
    diff: () => (diff ??= changed()),
  };
  const evidence = `run ${first.run} -> run ${run.run}, PR ${run.pr}`;
  for (const entry of first.findings) {
    const verdict = judgeLater(entry, ctx);
    if (verdict === 'real') {
      tally.labels.push(
        label(entry.id, 'real', RULES.coveredLater, at, evidence),
      );
    } else if (verdict === 'ambiguous') tally.ambiguous += 1;
    else if (verdict === 'unresolved') tally.unresolved += 1;
  }
  return tally;
}

/**
 * @param {{state: object, run: object, at: string, repo?: string,
 *          changed?: () => ({files: Set<string>} | {unknown: string})}} input
 * @returns {{labels: any[], ambiguous: number, unresolved: number}}
 */
export function deriveLabels({ state, run, at, repo = '.', changed }) {
  if (run.gate !== 'guardian')
    return { labels: [], ambiguous: 0, unresolved: 0 };
  const diffOf = changed ?? (() => changedFiles(repo, run.base, run.head));
  const coverage = fromCoverage(state, run, at, diffOf);
  const done = new Set(state.labels.map((l) => `${l.finding}\0${l.rule}`));
  const labels = [];
  for (const l of [...fromSuppressions(run, at), ...coverage.labels]) {
    const key = `${l.finding}\0${l.rule}`;
    if (done.has(key)) continue;
    done.add(key);
    labels.push(l);
  }
  return { ...coverage, labels };
}
