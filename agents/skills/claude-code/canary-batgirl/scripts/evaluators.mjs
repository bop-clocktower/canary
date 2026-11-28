// evaluators -- which function scores which dimension.
//
// A module of its own so that scorecard.mjs depends on two modules rather
// than four: the perf coupling rule (outgoing / (incoming + outgoing) <= 0.7)
// is what shapes this split, not a design preference.

import { closureExercise, coverageShare, escapedDefects } from './evidence.mjs';
import {
  redMainlineCommits,
  unexplainedSwitchOffs,
  vacuousTests,
} from './suite.mjs';

/** Dimension id to its evaluator; one entry per DIMENSIONS row. */
export const EVALUATORS = Object.freeze({
  'escaped-defects': escapedDefects,
  'coverage-verified-share': coverageShare,
  'closure-exercise': closureExercise,
  'unexplained-switch-offs': unexplainedSwitchOffs,
  'vacuous-tests': vacuousTests,
  'red-mainline-commits': redMainlineCommits,
});
