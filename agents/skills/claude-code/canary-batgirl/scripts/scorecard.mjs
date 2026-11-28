// scorecard -- assemble the six dimensions into the report.
//
// The report has no composite score (spec D3) and no field keyed by anything
// an input said. `abstained` is true when no dimension was assessed; the CLI
// exits 3 on it (ADR 0009). Limits are left to each evaluator's default
// (read.mjs LIMITS) unless a caller passes its own.

import { DIMENSIONS, evaluate } from './dimension.mjs';
import { EVALUATORS } from './evaluators.mjs';

/**
 * @param {Record<string, {source: string|null, read: object}>} inputs
 * @param {{branch: string, limits?: object}} opts
 */
export function assembleReport(inputs, { branch, limits }) {
  const opts = { branch, limits };
  const dimensions = DIMENSIONS.map(({ id }) =>
    evaluate(id, inputs[id], EVALUATORS[id], opts),
  );
  const assessed = dimensions.filter((d) => d.status === 'assessed').length;
  return { abstained: assessed === 0, assessed, dimensions };
}
