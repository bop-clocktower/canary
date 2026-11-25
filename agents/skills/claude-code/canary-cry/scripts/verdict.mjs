// canary-cry verdicts -- PURE, NO IMPORTS (#608 P3; spec "Verdicts and
// convergence", D3). One module decides what a finding is. The browser
// runtime (runtime/cry-runtime.mjs) judges each scenario with it inside the
// Playwright run, so a spec re-run standalone reaches the same verdict and
// fingerprint (SC12); the executor folds the scenarios into a run status and
// an exit code with it.
//
// It has no imports on purpose: codegen copies it into every run dir beside
// the runtime, so it must stand alone there.
//
// The ladder, first match wins:
//   abstain: flow-broken@<step>  a step BEFORE the abuse point failed -- a
//                                stale flows file, not a finding (SC14)
//   corrupted (state-verified)   >= 1 invariant breached
//   abstain: probe-failed@<id>   a probe errored, so the state is unknown;
//                                never clean (SC21), and it outranks a
//                                symptom, which would understate it
//   symptom (observed)           no breach, >= 1 UI signal
//   abstain: no-probes           the flow declares no invariant
//   clean                        >= 1 invariant checked, no breach, no signal

const FIDELITY = Object.freeze({
  corrupted: 'state-verified',
  symptom: 'observed',
  clean: 'state-verified',
  abstain: null,
});

/** JSON with object keys sorted, so `equals` ignores key order. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

/**
 * Evaluate one invariant's `expect` against its before/after probe values.
 * `delta` is after - before for one logical completion of the flow.
 * @returns {{breached: boolean} | {error: string}}
 */
export function checkExpect(expect, before, after) {
  if (Object.hasOwn(expect, 'equals')) {
    return { breached: canonical(after) !== canonical(expect.equals) };
  }
  if (typeof before !== 'number' || typeof after !== 'number') {
    return {
      error: `delta needs numbers, got ${typeof before} before and ${typeof after} after`,
    };
  }
  return { breached: after - before !== expect.delta };
}

const verdict = (name, reason = null, fingerprints = []) => ({
  verdict: name,
  reason,
  fidelity: FIDELITY[name],
  fingerprints,
});

/**
 * A scenario that could not be judged at all: the runtime threw, or the
 * executor found no observation for it. An abstention, never a clean.
 */
export const abstained = (reason) => verdict('abstain', reason);

/** Unique, in first-seen order. */
const unique = (list) => [...new Set(list)];

/**
 * @param {{flow: string, pattern: string, brokenAt: string | null,
 *   invariants: {id: string, breached?: boolean, error?: string}[],
 *   signals: {kind: string}[]}} input
 * @returns {{verdict: string, reason: string | null,
 *   fidelity: string | null, fingerprints: string[]}}
 */
export function scenarioVerdict({
  flow,
  pattern,
  brokenAt,
  invariants,
  signals,
}) {
  if (brokenAt !== null) return verdict('abstain', `flow-broken@${brokenAt}`);
  const fp = (id) => `${flow}:${pattern}:${id}`;
  const breached = invariants.filter((inv) => inv.breached === true);
  const signalFps = unique(signals.map((s) => fp(s.kind)));
  if (breached.length) {
    return verdict('corrupted', null, [
      ...breached.map((inv) => fp(inv.id)),
      ...signalFps,
    ]);
  }
  const failed = invariants.find((inv) => inv.error !== undefined);
  if (failed) return verdict('abstain', `probe-failed@${failed.id}`);
  if (signalFps.length) return verdict('symptom', null, signalFps);
  if (!invariants.length) return verdict('abstain', 'no-probes');
  return verdict('clean');
}

/**
 * The run's status from its scenario verdicts. Zero scenarios, or every one
 * abstaining, is ABSTAINED -- a zero denominator is not a pass (D3, #508).
 * @param {{verdict: string, reason: string | null}[]} scenarios
 */
export function summarize(scenarios) {
  const counts = { corrupted: 0, symptom: 0, clean: 0, abstain: 0 };
  const reasons = new Map();
  for (const s of scenarios) {
    counts[s.verdict] += 1;
    if (s.verdict === 'abstain') {
      reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
    }
  }
  if (!scenarios.length) {
    return { status: 'abstained', reason: 'zero scenarios', counts };
  }
  if (counts.abstain < scenarios.length) {
    return { status: 'ok', reason: null, counts };
  }
  const why = [...reasons].map(([r, n]) => `${r} ${n}`).join(', ');
  return {
    status: 'abstained',
    reason: `every scenario abstained (${why})`,
    counts,
  };
}

/**
 * Advisory by default. Under --strict: 3 when the run ABSTAINED, 1 when a
 * scenario is state-verified corrupted, else 0 -- a symptom never fails it.
 */
export function exitCode(summary, strict) {
  if (!strict) return 0;
  if (summary.status === 'abstained') return 3;
  return summary.counts.corrupted > 0 ? 1 : 0;
}
