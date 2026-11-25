// canary-cry scenario matrix -- PURE (spec "Matrix", #608; Tier-0: no
// network, no agent, no clock). Declared flows x the abuse-pattern catalog,
// ranked and cut to an amplitude's budget. The same flows, amplitude, seed,
// target and critical areas always give the same document, byte for byte
// (SC1): nothing here reads the time, the environment, or Math.random, and
// every sort is a code-unit comparison, never a locale one.
//
// The seed is RECORDED, never consumed: at run time it feeds only
// {{unique.*}} test data (#608 P3). It never selects a scenario.

import { INTENSITY_CEILING, PATTERNS } from './patterns.mjs';

// The house high-risk cut (canary-katana areas.mjs, canary-failure-impact).
const CRITICAL_RISK = 0.7;
const CRITICAL_BOOST = 2;

const rounds = (n) => Array.from({ length: n }, (_, i) => i + 1);

/** Budgets (spec D5): flows hit, pattern set, and intensity rounds. */
export const AMPLITUDES = Object.freeze({
  whisper: Object.freeze({ radius: 3, coreOnly: true, intensities: [1] }),
  shout: Object.freeze({ radius: 8, coreOnly: false, intensities: [1, 2] }),
  scream: Object.freeze({
    radius: Infinity,
    coreOnly: false,
    intensities: rounds(INTENSITY_CEILING),
  }),
});

const writes = (steps) => steps.filter((s) => s.writes === true);

/** The steps each pattern `anchor` attacks (patterns.mjs names them). */
const ANCHORS = Object.freeze({
  write: (flow) => writes(flow.steps),
  'write-not-last': (flow) => writes(flow.steps.slice(0, -1)),
  'await-response': (flow) =>
    flow.steps.filter((s) => typeof s.awaitResponse === 'string'),
  'first-write': (flow) => writes(flow.steps).slice(0, 1),
  'last-step': (flow) => flow.steps.slice(-1),
});

const hasAccount = (target, key) =>
  target.accounts !== null &&
  typeof target.accounts === 'object' &&
  Object.hasOwn(target.accounts, key);

/** What a target-scoped pattern needs the target to declare. */
const REQUIRES = Object.freeze({
  'session-keys': (target) => (target.auth?.sessionKeys?.length ?? 0) > 0,
  'two-accounts': (target) =>
    Boolean(target.auth) && hasAccount(target, 'A') && hasAccount(target, 'B'),
});

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byScoreThenId = (a, b) => b.score - a.score || byCodeUnit(a.id, b.id);

const norm = (p) => String(p).replace(/^\.\//, '').replace(/\/+$/, '');

/** An area at or under the flow's criticalArea, at the high-risk cut. */
function isCritical(flow, areas) {
  if (areas === null || typeof flow.criticalArea !== 'string') return false;
  const root = norm(flow.criticalArea);
  return areas.some((area) => {
    const p = norm(area.path);
    const under = p === root || p.startsWith(`${root}/`);
    return under && Number(area.risk_score) >= CRITICAL_RISK;
  });
}

function applies(pattern, target) {
  if (pattern.requires === null) return true;
  return target !== null && REQUIRES[pattern.requires](target);
}

/** One flow's scenarios before intensity: every pattern x anchored step. */
function flowScenarios(flow, patterns, target, areas) {
  const boost = isCritical(flow, areas) ? CRITICAL_BOOST : 0;
  const out = [];
  for (const pattern of patterns.filter((p) => applies(p, target))) {
    for (const step of ANCHORS[pattern.anchor](flow)) {
      const score = flow.risk * pattern.weight + boost;
      out.push({ flow: flow.id, pattern: pattern.id, step: step.id, score });
    }
  }
  return out;
}

/** Flows ranked by their best scenario; a flow nothing applies to drops. */
function rankFlows(flows, patterns, target, areas) {
  return flows
    .map((flow) => {
      const base = flowScenarios(flow, patterns, target, areas);
      const score = Math.max(0, ...base.map((s) => s.score));
      return { id: flow.id, score, base };
    })
    .filter((ranked) => ranked.base.length > 0)
    .sort(byScoreThenId);
}

function atIntensity(chosen, n) {
  return chosen
    .flatMap((ranked) => ranked.base)
    .map((s) => ({
      id: `${s.flow}:${s.pattern}:i${n}:s${s.step}`,
      flow: s.flow,
      pattern: s.pattern,
      intensity: n,
      step: s.step,
      score: s.score,
    }))
    .sort(byScoreThenId);
}

/** Target-scoped patterns left out for want of --target: listed, not hidden. */
function unscheduled(patterns, target) {
  if (target !== null) return [];
  return patterns
    .filter((p) => p.requires !== null)
    .map((p) => ({ pattern: p.id, reason: 'no --target' }));
}

function budgetFor(amplitude) {
  if (!Object.hasOwn(AMPLITUDES, amplitude)) {
    throw new Error(`unknown amplitude: ${amplitude}`);
  }
  return AMPLITUDES[amplitude];
}

/** Zero scenarios is an abstention, never an empty pass (SC24, #508). */
const outcome = (scenarios) =>
  scenarios.length
    ? { status: 'ok', reason: null }
    : { status: 'abstained', reason: 'zero scenarios' };

/**
 * The matrix document (`cry matrix --json`; P3 writes it as matrix.json).
 * @param {{flows: object[], amplitude: string, seed: number,
 *   target?: {name: string, spec: object} | null,
 *   areas?: object[] | null}} input
 */
export function buildMatrix(input) {
  const budget = budgetFor(input.amplitude);
  const target = input.target ?? null;
  const areas = input.areas ?? null;
  const patterns = PATTERNS.filter((p) => p.core || !budget.coreOnly);
  const spec = target === null ? null : target.spec;
  const chosen = rankFlows(input.flows, patterns, spec, areas).slice(
    0,
    budget.radius,
  );
  const scenarios = budget.intensities.flatMap((n) => atIntensity(chosen, n));
  return {
    format: 'canary.cry-matrix/1',
    ...outcome(scenarios),
    amplitude: input.amplitude,
    seed: input.seed,
    ranking: areas === null ? 'declared' : 'declared+critical-areas',
    target: target === null ? null : target.name,
    patterns: patterns.map((p) => p.id),
    intensities: [...budget.intensities],
    flows: chosen.map((ranked) => ranked.id),
    unscheduled: unscheduled(patterns, target),
    scenarios,
  };
}

/** The canonical serialization, so equal input gives equal bytes. */
export function matrixJson(matrix) {
  return JSON.stringify(matrix, null, 2);
}
