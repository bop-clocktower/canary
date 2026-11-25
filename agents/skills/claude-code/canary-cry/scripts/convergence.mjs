// canary-cry rounds and convergence -- PURE (#608 P4; spec D5 and "Verdicts
// and convergence"; SC17). No I/O, no clock, no imports: the executor calls
// `decideRound` between scenarios and does what it says.
//
// INPUT CONTRACT (what the executor adapts to). One record per scenario run:
//
//   ScenarioResult = { id: string, verdict: string, fingerprints: string[] }
//
//   - `id` is the matrix scenario id `<flow>:<pattern>:i<n>:s<step>`.
//   - `verdict` is the spec's verdict string: 'corrupted', 'symptom', 'clean',
//     or one starting 'abstain' ('abstain: no-probes', ...). Only the
//     'abstain' prefix is read here.
//   - `fingerprints` are the scenario's findings, each built by `fingerprint`
//     below: one per breached invariant, one per UI-signal kind observed.
//     Empty for clean and abstained scenarios.
//
// The rounds come from the matrix (`planRounds(matrix)`), which needs only
// `matrix.scenarios[].{id, intensity}`, the shape matrix.json has had since P1.
//
// RULES (spec D5). whisper runs i1 and shout i1, i2: their whole budget, with
// no convergence claim. scream runs i1 -> i3 and stops early after BARREN_LIMIT
// consecutive barren rounds, printing `converged after round <n>`. No round
// above ROUND_CEILING is ever planned, whatever the matrix says.
//
// A round is BARREN when it adds no fingerprint unseen in earlier rounds. A
// round in which every scenario abstained is not barren: it measured nothing,
// and two rounds of nothing are not convergence (cannot-verify is never a
// quiet clean). It breaks the streak instead.

/** @typedef {{id: string, verdict: string, fingerprints: string[]}} ScenarioResult */
/** @typedef {{intensity: number, fresh: string[], abstained: boolean,
 *   barren: boolean}} RoundSummary one completed round */

/** The intensity ceiling (spec D5); the tests pin it to patterns.mjs's. */
export const ROUND_CEILING = 3;
const BARREN_LIMIT = 2;

/**
 * A finding's identity across rounds: flow + pattern + invariant id, or + UI
 * signal kind. Intensity and step are left out on purpose, so the same breach
 * found again at a higher intensity is not "new". The `invariant=` /
 * `signal=` tag keeps an invariant named like a signal kind distinct from it.
 * @param {{flow: string, pattern: string, invariant?: string,
 *   signal?: string}} finding exactly one of invariant / signal
 */
export function fingerprint({ flow, pattern, invariant, signal }) {
  if ((invariant === undefined) === (signal === undefined)) {
    throw new Error('fingerprint needs exactly one of invariant or signal');
  }
  const what =
    invariant === undefined ? `signal=${signal}` : `invariant=${invariant}`;
  return `${flow}:${pattern}:${what}`;
}

/**
 * The matrix's scenarios grouped into rounds, ascending by intensity, capped
 * at the ceiling. Ids keep matrix order within a round.
 * @param {{scenarios: {id: string, intensity: number}[]}} matrix
 * @returns {{intensity: number, ids: string[]}[]}
 */
export function planRounds(matrix) {
  const byIntensity = new Map();
  for (const s of matrix.scenarios) {
    if (s.intensity > ROUND_CEILING) continue;
    if (!byIntensity.has(s.intensity)) byIntensity.set(s.intensity, []);
    byIntensity.get(s.intensity).push(s.id);
  }
  return [...byIntensity.keys()]
    .sort((a, b) => a - b)
    .map((intensity) => ({ intensity, ids: byIntensity.get(intensity) }));
}

const isAbstain = (result) => result.verdict.startsWith('abstain');

/** One completed round's summary; `seen` accumulates across rounds. */
function summarize(round, byId, seen) {
  const results = round.ids.map((id) => byId.get(id));
  const fresh = [];
  for (const fp of results.flatMap((r) => r.fingerprints)) {
    if (seen.has(fp)) continue;
    seen.add(fp);
    fresh.push(fp);
  }
  const abstained = results.every(isAbstain);
  return {
    intensity: round.intensity,
    fresh,
    abstained,
    barren: !abstained && fresh.length === 0,
  };
}

/** Whether the last BARREN_LIMIT summaries are all barren. */
function converged(summaries) {
  if (summaries.length < BARREN_LIMIT) return false;
  return summaries.slice(-BARREN_LIMIT).every((s) => s.barren);
}

const done = (reason, summaries, line = null) => ({
  status: 'done',
  reason,
  line,
  rounds: summaries,
});

/**
 * What runs next, given every result so far (fresh run, mid-round, or resumed
 * from a checkpoint -- the same call). Results whose id is in no round are
 * ignored; a re-recorded id keeps its last result.
 * @param {{amplitude: string, rounds: {intensity: number, ids: string[]}[],
 *   results: ScenarioResult[]}} input
 * @returns {{status: 'run', intensity: number, pending: string[],
 *   rounds: RoundSummary[]} | {status: 'done',
 *   reason: 'converged' | 'ceiling' | 'budget', line: string | null,
 *   rounds: RoundSummary[]}} `rounds` summarizes each COMPLETED round
 */
export function decideRound({ amplitude, rounds, results }) {
  const byId = new Map(results.map((r) => [r.id, r]));
  const seen = new Set();
  const summaries = [];
  for (const round of rounds) {
    const pending = round.ids.filter((id) => !byId.has(id));
    if (pending.length) {
      const { intensity } = round;
      return { status: 'run', intensity, pending, rounds: summaries };
    }
    summaries.push(summarize(round, byId, seen));
    if (amplitude === 'scream' && converged(summaries)) {
      const line = `converged after round ${summaries.length}`;
      return done('converged', summaries, line);
    }
  }
  return done(amplitude === 'scream' ? 'ceiling' : 'budget', summaries);
}
