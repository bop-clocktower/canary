// scorecard -- assemble the six dimensions into the report, and render JSON.
//
// The report has no composite score (spec D3) and no field keyed by anything
// an input said. `abstained` is true when no dimension was assessed; the CLI
// exits 3 on it (ADR 0009).

import { DIMENSIONS, evaluate } from './dimension.mjs';
import { closureExercise, coverageShare, escapedDefects } from './evidence.mjs';
import { redMainlineCommits } from './mainline.mjs';
import { unexplainedSwitchOffs, vacuousTests } from './suite.mjs';
import { LIMITS } from './read.mjs';
import { plain } from './text.mjs';

export const SCHEMA_VERSION = 1;

const EVALUATORS = {
  'escaped-defects': escapedDefects,
  'coverage-verified-share': coverageShare,
  'closure-exercise': closureExercise,
  'unexplained-switch-offs': unexplainedSwitchOffs,
  'vacuous-tests': vacuousTests,
  'red-mainline-commits': redMainlineCommits,
};

/**
 * @param {Record<string, {source: string|null, read: object}>} inputs
 * @param {{branch: string, limits?: object}} opts
 */
export function assembleReport(inputs, { branch, limits = LIMITS }) {
  const opts = { branch, limits };
  const dimensions = DIMENSIONS.map(({ id }) =>
    evaluate(id, inputs[id], EVALUATORS[id], opts),
  );
  const assessed = dimensions.filter((d) => d.status === 'assessed').length;
  return { abstained: assessed === 0, assessed, dimensions };
}

const nullable = (v) => (v === null || v === undefined ? null : plain(v));

/** Every string that can carry input text goes through `plain`. */
function jsonDimension(d) {
  return {
    id: d.id,
    title: d.title,
    better: d.better,
    kind: d.kind,
    status: d.status,
    value: d.value,
    basis: nullable(d.basis),
    source: nullable(d.source),
    reason: nullable(d.reason),
    detail: d.detail,
  };
}

export function renderJson(report) {
  return JSON.stringify(
    {
      schema_version: SCHEMA_VERSION,
      abstained: report.abstained,
      assessed: report.assessed,
      dimensions: report.dimensions.map(jsonDimension),
    },
    null,
    2,
  );
}
