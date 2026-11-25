// canary-cry round loop (#608 P4; spec D5, "Verdicts and convergence"; SC17,
// SC18). The executor's half of convergence.mjs and checkpoint.mjs: it asks
// `decideRound` what runs next, runs it one scenario at a time through an
// injected `runOne`, records each result into the checkpoint and hands the
// checkpoint to an injected `save` after EVERY scenario, and stops on the
// first of: the budget spent, convergence, the intensity ceiling, the
// --max-wall deadline (checked before each scenario, on an injected clock),
// or a crashed scenario. No I/O and no clock of its own, so every stop is
// provable with injected verdict sequences.
//
// `toResult` is the thin adapter from what the runtime observes to
// convergence's input contract, `{id, verdict, fingerprints}`.

import {
  deadlineAt,
  newCheckpoint,
  parseMaxWall,
  partialLine,
  recordResult,
  wallExpired,
} from './checkpoint.mjs';
import { decideRound, fingerprint, planRounds } from './convergence.mjs';

const unique = (list) => [...new Set(list)];

/**
 * An observation (runtime/cry-runtime.mjs) as convergence reads it. The
 * fingerprints mirror verdict.mjs's ladder -- a corrupted scenario's breaches
 * and signal kinds, a symptom's signal kinds, nothing for clean or abstain --
 * built with convergence's own `fingerprint`, so a breach found again at a
 * higher intensity is not "new". No observation is `abstain: no-observation`.
 * @param {{id: string, flow: string, pattern: string}} scenario
 * @param {object | null} observation
 */
export function toResult(scenario, observation) {
  const { id, flow, pattern } = scenario;
  if (observation === null) {
    return { id, verdict: 'abstain: no-observation', fingerprints: [] };
  }
  const { verdict, reason } = observation;
  if (verdict === 'abstain') {
    return { id, verdict: `abstain: ${reason}`, fingerprints: [] };
  }
  const breaches =
    verdict === 'corrupted'
      ? observation.invariants.filter((inv) => inv.breached === true)
      : [];
  const kinds =
    verdict === 'clean' ? [] : unique(observation.signals.map((s) => s.kind));
  const fingerprints = [
    ...breaches.map((inv) => fingerprint({ flow, pattern, invariant: inv.id })),
    ...kinds.map((signal) => fingerprint({ flow, pattern, signal })),
  ];
  return { id, verdict, fingerprints };
}

const stopped = (stop, line, decision, checkpoint, crash) => ({
  stop,
  line,
  rounds: decision.rounds,
  checkpoint,
  ...(crash === undefined ? {} : { crash }),
});

/** The line a finished run prints: convergence's own, or the ceiling's. */
function doneLine(decision) {
  if (decision.reason !== 'ceiling') return decision.line;
  const n = decision.rounds.length;
  return `not converged: stopped at the intensity ceiling after round ${n}`;
}

/**
 * @param {{manifest: {amplitude: string, scenarios: object[]},
 *   run: {id: string, manifestSha: string}, resumed: object | null,
 *   runOne: (scenario: object) => Promise<{result?: object, crashed?: object}>,
 *   save: (checkpoint: object) => void, clock: () => number,
 *   maxWall: string | null}} input `resumed` is a checkpoint planResume
 *   already trusted; `maxWall` was validated by the CLI
 * @returns {Promise<{stop: 'budget' | 'converged' | 'ceiling' | 'partial' |
 *   'crashed', line: string | null, rounds: object[],
 *   checkpoint: {results: {id: string, verdict: string,
 *   fingerprints: string[]}[]}, crash?: {code: number | null,
 *   stderr: string[]}}>}
 */
export async function runRounds(input) {
  const { manifest, run, runOne, save, clock } = input;
  const wallMs = input.maxWall === null ? null : parseMaxWall(input.maxWall).ms;
  const deadline = deadlineAt(clock(), wallMs);
  const total = manifest.scenarios.length;
  const byId = new Map(manifest.scenarios.map((s) => [s.id, s]));
  const rounds = planRounds(manifest);
  const { amplitude } = manifest;
  let checkpoint =
    input.resumed ??
    newCheckpoint({ runId: run.id, manifestSha: run.manifestSha, total });
  save(checkpoint);
  for (;;) {
    const decision = decideRound({
      amplitude,
      rounds,
      results: checkpoint.results,
    });
    if (decision.status === 'done') {
      return stopped(decision.reason, doneLine(decision), decision, checkpoint);
    }
    for (const id of decision.pending) {
      if (wallExpired(deadline, clock)) {
        const line = partialLine(checkpoint);
        return stopped('partial', line, decision, checkpoint);
      }
      const outcome = await runOne(byId.get(id));
      if (outcome.crashed !== undefined) {
        return stopped('crashed', null, decision, checkpoint, outcome.crashed);
      }
      checkpoint = recordResult(checkpoint, outcome.result);
      save(checkpoint);
    }
  }
}
