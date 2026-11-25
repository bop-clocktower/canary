// canary-cry manifest -- PURE (#608 P2; ADR 0046 decision 1; spec D4/D6).
// The manifest is the whole blast radius of a live run: every scenario, the
// flows it drives in full, every write step, every probe VERBATIM (a shell
// probe's argv is approved by being shown), the egress hosts, the account env
// var NAMES, and the side effects canary-cry cannot intercept.
//
// `manifest-sha` is the sha256 of the canonical (sorted-key) JSON, so the
// operator's approval binds to exactly what was printed: change anything
// that would run and the sha changes, and a stale `--confirm` is refused.
//
// No value is read here. Accounts arrive as env var names from targets.json;
// their values are checked by gate.mjs and never passed in.

import { createHash } from 'node:crypto';

import { buildMatrix } from './matrix.mjs';

export const SERVER_SIDE_LIMIT =
  'server-side side effects (email, webhooks, payments) are NOT intercepted by canary-cry.';

/** JSON with object keys sorted at every depth; arrays keep their order. */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  const keys = Object.keys(value).sort();
  return Object.fromEntries(keys.map((k) => [k, sortKeys(value[k])]));
}

/** @returns {string} sha256 hex of the canonical manifest */
export function manifestSha(manifest) {
  return createHash('sha256').update(canonicalJson(manifest)).digest('hex');
}

/**
 * The flows the run drives: those with a scheduled scenario, plus the
 * target's sign-in / sign-out flows (a run executes those too), in the
 * flows file's own order.
 */
function drivenFlows(flows, matrix, auth) {
  const ids = new Set(matrix.flows);
  if (auth) for (const id of [auth.signIn, auth.signOut]) ids.add(id);
  return flows.filter((flow) => ids.has(flow.id));
}

const STEP_FIELDS = [
  'action',
  'url',
  'selector',
  'value',
  'key',
  'awaitResponse',
];

function writeSteps(flows) {
  return flows.flatMap((flow) =>
    flow.steps
      .filter((step) => step.writes === true)
      .map((step) => {
        const shown = STEP_FIELDS.filter((k) => step[k] !== undefined);
        return {
          flow: flow.id,
          step: step.id,
          ...Object.fromEntries(shown.map((k) => [k, step[k]])),
        };
      }),
  );
}

function probes(flows) {
  return flows.flatMap((flow) =>
    (flow.invariants ?? []).map((inv) => ({
      flow: flow.id,
      invariant: inv.id,
      probe: inv.probe,
      expect: inv.expect,
    })),
  );
}

/**
 * @param {{flowsDoc: object, target: {name: string, spec: object},
 *   matrix: object}} input a validated flows document, a gated target, and
 *   the matrix built for that target
 */
export function buildManifest({ flowsDoc, target, matrix }) {
  const { spec } = target;
  const flows = drivenFlows(flowsDoc.flows, matrix, spec.auth);
  const accounts = spec.accounts ?? {};
  return {
    format: 'canary.cry-manifest/1',
    target: {
      name: target.name,
      baseURL: spec.baseURL,
      environment: spec.environment,
    },
    egressHosts: [...spec.hosts],
    accounts: Object.keys(accounts)
      .filter((k) => k !== '//')
      .map((account) => ({ account, env: accounts[account].env })),
    auth: spec.auth ?? null,
    amplitude: matrix.amplitude,
    seed: matrix.seed,
    scenarios: matrix.scenarios,
    flows,
    fixtures: flowsDoc.fixtures ?? {},
    writes: writeSteps(flows),
    probes: probes(flows),
    serverSideLimit: SERVER_SIDE_LIMIT,
  };
}

/** The manifest file's bytes: the canonical JSON, indented for a reader. */
export function manifestFileText(manifest) {
  return `${JSON.stringify(JSON.parse(canonicalJson(manifest)), null, 2)}\n`;
}

/**
 * Matrix, manifest and sha for a gated target. An empty matrix has no
 * manifest (and so nothing anyone could confirm): `manifest` and `sha` are
 * null and the caller abstains.
 * @param {{flowsDoc: object, target: {name: string, spec: object},
 *   amplitude: string, seed: number}} input
 */
export function planRun({ flowsDoc, target, amplitude, seed }) {
  const matrix = buildMatrix({
    flows: flowsDoc.flows,
    amplitude,
    seed,
    target,
  });
  if (matrix.status === 'abstained') {
    return { matrix, manifest: null, sha: null };
  }
  const manifest = buildManifest({ flowsDoc, target, matrix });
  return { matrix, manifest, sha: manifestSha(manifest) };
}
