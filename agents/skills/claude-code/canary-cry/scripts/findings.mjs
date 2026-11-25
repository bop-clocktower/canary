// canary-cry findings -- PURE (#608 P3; spec "Outputs", "Verdicts"). Folds
// the runtime's per-scenario observations into findings.json
// (`canary.cry-findings/1`) and the text a confirmed run prints.
//
// A scheduled scenario with no observation is an abstention
// (`no-observation`), never a silent gap: the denominator is the confirmed
// manifest's scenario list, not whatever the browser happened to write.

import { fileStem } from './codegen.mjs';
import { ABSTAINED_LINE } from './render.mjs';
import { abstained, summarize } from './verdict.mjs';

const PROG = 'canary-cry';
const RANK = { corrupted: 0, symptom: 1, abstain: 2, clean: 3 };

const uniqueSorted = (list) => [...new Set(list)].sort();

function scenarioEntry(scenario, observation) {
  const stem = fileStem(scenario.id);
  const seen = observation ?? {
    ...abstained('no-observation'),
    invariants: [],
    signals: [],
    blockedEgress: [],
    error: null,
  };
  return {
    id: scenario.id,
    flow: scenario.flow,
    pattern: scenario.pattern,
    intensity: scenario.intensity,
    step: scenario.step,
    score: scenario.score,
    verdict: seen.verdict,
    fidelity: seen.fidelity,
    reason: seen.reason,
    fingerprints: seen.fingerprints,
    invariants: seen.invariants,
    signals: seen.signals,
    blockedEgress: seen.blockedEgress,
    error: seen.error,
    repro: {
      spec: `specs/${stem}.spec.mjs`,
      observation: `observations/${stem}.json`,
    },
  };
}

/**
 * The run's status: a run-level abstention first, then a --max-wall stop
 * (PARTIAL, #608 P4), else what the scenario verdicts add up to.
 */
function statusOf(scenarios, abstainedReason, stop) {
  const summary = summarize(scenarios);
  if (abstainedReason) {
    return { ...summary, status: 'abstained', reason: abstainedReason };
  }
  if (stop?.reason === 'partial') {
    return { ...summary, status: 'partial', reason: stop.line };
  }
  return summary;
}

/**
 * findings.json for a confirmed run.
 * @param {{run: object, manifest: {scenarios: object[]},
 *   observations: Map<string, object | null> | null,
 *   abstainedReason?: string, stop?: {reason: string, line: string | null,
 *   rounds: object[]}}} input `manifest.scenarios` is the denominator: the
 *   scenarios that ran. `observations` is null when none ran (the run
 *   abstained before the browser started). `stop` is how the round loop
 *   ended (rounds.mjs), absent when it never started.
 */
export function buildFindings({
  run,
  manifest,
  observations,
  abstainedReason,
  stop,
}) {
  const scenarios =
    observations === null
      ? []
      : manifest.scenarios.map((s) =>
          scenarioEntry(s, observations.get(fileStem(s.id)) ?? null),
        );
  return {
    format: 'canary.cry-findings/1',
    run,
    ...statusOf(scenarios, abstainedReason, stop),
    stop: stop ? { reason: stop.reason, line: stop.line } : null,
    rounds: stop?.rounds ?? [],
    scenarios,
    fingerprints: uniqueSorted(scenarios.flatMap((s) => s.fingerprints)),
    blockedEgress: uniqueSorted(scenarios.flatMap((s) => s.blockedEgress)),
  };
}

const byRank = (a, b) =>
  RANK[a.verdict] - RANK[b.verdict] ||
  b.score - a.score ||
  (a.id < b.id ? -1 : 1);

const valueText = (v) => JSON.stringify(v);

function invariantLines(s) {
  return s.invariants
    .filter((inv) => inv.breached === true || inv.error !== undefined)
    .map((inv) =>
      inv.error !== undefined
        ? `      ${inv.id}: probe failed: ${inv.error}`
        : `      ${inv.id}: before ${valueText(inv.before)} -> after ` +
          `${valueText(inv.after)} (expect ${valueText(inv.expect)})`,
    );
}

function scenarioLines(s) {
  const label = s.verdict === 'abstain' ? `abstain: ${s.reason}` : s.verdict;
  const fidelity = s.fidelity ? ` (${s.fidelity})` : '';
  return [
    `  ${label}${fidelity}  ${s.id}`,
    ...s.fingerprints.map((fp) => `      fingerprint ${fp}`),
    ...invariantLines(s),
  ];
}

/**
 * The text of a confirmed run.
 * @param {object} doc findings.json
 * @param {{dir: string, findings: string}} where
 */
export function renderFindings(doc, where) {
  const c = doc.counts;
  const lines = [
    `${PROG} run --live ${doc.run.target} -- ${doc.scenarios.length} ` +
      `scenario(s), amplitude ${doc.run.amplitude}, seed ${doc.run.seed}`,
    ...[...doc.scenarios].sort(byRank).flatMap(scenarioLines),
    `corrupted ${c.corrupted}, symptom ${c.symptom}, clean ${c.clean}, ` +
      `abstain ${c.abstain}`,
  ];
  if (doc.blockedEgress.length) {
    lines.push(`blocked egress (aborted): ${doc.blockedEgress.join(', ')}`);
  }
  // `converged after round <n>`, the ceiling's line, or PARTIAL's (#608 P4).
  if (doc.stop?.line) lines.push(doc.stop.line);
  if (doc.status === 'abstained') {
    lines.push(`ABSTAINED: ${doc.reason}`, ABSTAINED_LINE);
  }
  lines.push(
    `findings: ${where.findings}`,
    `replay a scenario: cd ${where.dir} && npx playwright test ` +
      '-c playwright.config.mjs specs/<scenario>.spec.mjs',
  );
  return lines.join('\n');
}

/**
 * The exit code of a findings document (#608 P4 moved it here from
 * verdict.mjs: it judges a run, not a scenario). Advisory by default. Under --strict: 1 when a scenario is state-verified
 * corrupted, however the run ended; else 3 when it did not run its budget
 * (ABSTAINED, or a --max-wall PARTIAL: cannot-verify is never a pass); else
 * 0 -- a symptom never fails it.
 */
export function exitCode(summary, strict) {
  if (!strict) return 0;
  if (summary.counts.corrupted > 0) return 1;
  return summary.status === 'ok' ? 0 : 3;
}
