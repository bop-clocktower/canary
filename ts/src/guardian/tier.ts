/**
 * Tier-resolution seam for canary-pr-guardian (SC-5 core).
 *
 * Faithful TypeScript port of `agent/guardian/tier.py`.
 *
 * Resolves a *requested* guardian tier against the tier an agent runtime can
 * actually serve, and emits a **loud** degradation notice whenever the effective
 * tier drops below the request. The capability probe is an interface; the
 * Phase-3 default ({@link NoAgentProbe}) deterministically reports "no agent"
 * (tier 0 ceiling) **without importing any agent/LLM module** (SC-11). Phase 4
 * supplies a real probe ({@link module:./agent-tier}'s `InSessionAgentProbe`)
 * implementing the same interface -- `resolveTier`'s callers do not change.
 *
 * This is the CLI-wave companion the engine's `pr-check.ts` intentionally
 * deferred (its header notes the tier seam belongs to the CLI wave, alongside
 * `read_diff`). It lives here so `cli.ts` (pr-check/author-plan) can wire it.
 */

// The degradation notice text carries a warning sign (U+26A0) and an em-dash
// (U+2014) as load-bearing OUTPUT DATA -- it is rendered verbatim into the PR
// comment footer and the Actions `::warning::` channel, and asserted byte-exact
// against the Python oracle. Written as escapes to honor the ASCII-source rule.
const WARNING_SIGN = '\u{26A0}';
const EM_DASH = '\u{2014}';

/**
 * Canonical loud degradation notice (D6 / SC-5).
 *
 * Names the requested tier and stays loud -- a tier>0 result must never be
 * surfaced without this notice when the requested tier is unavailable.
 */
function degradationNotice(requested: number, effective: number): string {
  return (
    `${WARNING_SIGN} degraded: tier ${requested} unavailable ` +
    `(no agent runtime detected) ${EM_DASH} ran tier ${effective}`
  );
}

/**
 * Reports the highest tier an agent runtime can serve.
 *
 * Phase 3 has none; Phase 4 supplies a real probe (e.g. `InSessionAgentProbe`)
 * implementing this same interface so `resolveTier`'s callers do not change.
 */
export interface AgentCapabilityProbe {
  availableTier(): number;
}

/**
 * Deterministic Phase-3 probe: no agent runtime, so tier 0 is the ceiling.
 *
 * Imports no agent/LLM module (SC-11).
 */
export class NoAgentProbe implements AgentCapabilityProbe {
  availableTier(): number {
    return 0;
  }
}

/** The outcome of resolving a requested tier against available capability. */
export interface TierResolution {
  requested: number;
  effective: number;
  degraded_notice: string | null;
}

/**
 * Resolve `requested` against the probe's ceiling, degrading loudly.
 *
 * `probe` defaults to {@link NoAgentProbe}. The effective tier is
 * `min(requested, probe.availableTier())`; a loud {@link degradationNotice} is
 * attached iff the effective tier is below the request (else `null`).
 */
export function resolveTier(
  requested: number,
  probe: AgentCapabilityProbe | null = null,
): TierResolution {
  const activeProbe = probe ?? new NoAgentProbe();
  const available = activeProbe.availableTier();
  const effective = Math.min(requested, available);
  const notice =
    effective < requested ? degradationNotice(requested, effective) : null;
  return { requested, effective, degraded_notice: notice };
}
