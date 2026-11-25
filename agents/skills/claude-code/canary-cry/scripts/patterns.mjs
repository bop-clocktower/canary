// canary-cry abuse-pattern catalog -- DATA ONLY (spec "Abuse-pattern
// catalog", #608). Nothing here executes. `anchor` names which steps of a flow
// a pattern attacks and `requires` names what the target must declare; the
// matrix (matrix.mjs) is what reads them. `intensities` describes levels 1, 2
// and 3 in words for the manifest -- the code that injects them is the runtime
// (#608 P3), not this file.
//
// `weight` feeds the ranking score, flow.risk x weight. The spec fixes that a
// weight exists, not its value; these are the P1 values recorded in the plan
// (docs/changes/canary-cry/plans/2026-11-25-canary-cry-p1-plan.md): a pattern
// that corrupts state or leaks across accounts outranks one that only strains
// session handling.

/** The highest intensity any pattern runs at (spec D5: the ceiling). */
export const INTENSITY_CEILING = 3;

const pattern = (spec) =>
  Object.freeze({ ...spec, intensities: Object.freeze(spec.intensities) });

/** Catalog order is the order patterns are listed in every matrix. */
export const PATTERNS = Object.freeze([
  pattern({
    id: 'multi-submit',
    core: true,
    weight: 5,
    anchor: 'write',
    requires: null,
    intensities: ['2x @ no throttle', '3x @ 400 ms', '5x @ 3 s'],
  }),
  pattern({
    id: 'abandon-midflow',
    core: true,
    weight: 4,
    anchor: 'write-not-last',
    requires: null,
    intensities: ['back', 'reload', 'context.close()'],
  }),
  pattern({
    id: 'stale-optimistic',
    core: false,
    weight: 4,
    anchor: 'await-response',
    requires: null,
    intensities: ['delay past UI timeout', 'fake 500', 'drop'],
  }),
  pattern({
    id: 'duplicate-tab',
    core: false,
    weight: 3,
    anchor: 'write',
    requires: null,
    intensities: ['2 tabs racing', '3 tabs racing', '3 tabs racing'],
  }),
  pattern({
    id: 'token-expiry',
    core: false,
    weight: 3,
    anchor: 'first-write',
    requires: 'session-keys',
    intensities: ['before the write', 'between writes', 'before every step'],
  }),
  pattern({
    id: 'shared-machine',
    core: false,
    weight: 5,
    anchor: 'last-step',
    requires: 'two-accounts',
    intensities: ['sign-out', 'sign-out + back', 'no sign-out'],
  }),
]);
