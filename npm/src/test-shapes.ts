// GENERATED FILE — DO NOT EDIT.
// Verbatim copy of ts/src/core/test-shapes.ts, mirrored into this CommonJS
// package by scripts/sync-gate-result.mjs because the staged engine bundle is
// ESM and unavailable at test time. Edit the engine source and re-run:
//   node scripts/sync-gate-result.mjs
// `npm test` verifies this copy has not drifted (--check runs as pretest).

/**
 * The test shapes canary can emit — the single source of truth (#1206).
 *
 * The classifier's `test_type`, the framework probes' detected shape, and the
 * framework registry's categories are all drawn from this list, and the
 * classifier and probes are typed against `TestShape` so a shape outside it
 * fails to compile. `canary overlay lint` accepts these (plus the `all`
 * sentinel) as `deploy_to` targets; before this list existed it carried its
 * own five-name copy and called `mobile`, a shape the probes emit, a typo.
 *
 * ZERO imports on purpose: `npm/scripts/sync-gate-result.mjs` mirrors this file
 * verbatim into the CommonJS npm package, which cannot import the ESM engine.
 * Keep it pure data.
 */
export const TEST_SHAPES = [
  'e2e_ui',
  'frontend_unit',
  'api',
  'performance',
  'load',
  'accessibility',
  'security',
  'visual',
  'contract',
  'chaos',
  'synthetic_data',
  'observability',
  'mobile',
  'mutation',
  'static_analysis',
  'integration',
  'property',
  'llm_eval',
] as const;

export type TestShape = (typeof TEST_SHAPES)[number];
