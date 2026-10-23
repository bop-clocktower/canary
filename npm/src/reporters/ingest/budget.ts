// Ingest reporter: the strict size budget for `canary testtracker push` (#1355).
import type { FitResult } from './payload.js';

/** `CI` set to anything but empty, `false` or `0`: the convention CI hosts share. */
export function isCi(env: NodeJS.ProcessEnv): boolean {
  const ci = env.CI?.trim().toLowerCase();
  return !!ci && ci !== 'false' && ci !== '0';
}

/**
 * Under a strict budget a lossy fit is a refusal, not a warning: on an
 * unattended nightly a catalog-less run lands looking normal, and the suite can
 * no longer tell "did not run" from "does not exist". `why` names what turned
 * the strict budget on. Returns the refusal message, or null to push.
 */
export function budgetRefusal(fit: FitResult, why: string): string | null {
  const losses = [
    fit.catalogDropped &&
      'drop its catalog (collected), so the suite would land unmeasured',
    fit.overBudget &&
      'still leave it over budget, so the dashboard may reject it',
  ].filter(Boolean);
  if (!losses.length) return null;
  return (
    `canary testtracker: refused — the payload is ${fit.bytes} bytes, over the ` +
    `${fit.maxBytes}-byte budget, and fitting it would ${losses.join(' and ')}. ` +
    `The strict budget is on (${why}). Split the run into smaller suites, ` +
    `pass --no-collected if the reports are a subset, or pass ` +
    `--no-strict-budget to push the degraded payload anyway. Nothing was pushed.\n`
  );
}
