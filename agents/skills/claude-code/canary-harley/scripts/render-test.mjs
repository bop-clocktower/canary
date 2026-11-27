/**
 * canary-harley -- the text of one generated test, with its seed fixed.
 *
 * The seed is `--seed` when given, else derived from the candidate id, so it
 * is stable across runs and differs between tests. Nothing here reads a
 * clock or a random source.
 */
import { createHash } from 'node:crypto';

import { renderFastCheck } from './emit-fast-check.mjs';
import { renderHypothesis } from './emit-hypothesis.mjs';

const RENDERERS = { typescript: renderFastCheck, python: renderHypothesis };

// The first 31 bits of SHA-256 of the id. 31, not 32: fast-check reports a
// seed outside the int32 range as a different number, and the seed a failing
// run prints must be the one recorded in the file.
const derivedSeed = (id) =>
  parseInt(createHash('sha256').update(id).digest('hex').slice(0, 8), 16) >>> 1;

/**
 * @param {string} lang `typescript` or `python`
 * @param {object} proposal the proposal the candidate came from
 * @param {object} candidate a confirmed, emittable candidate
 * @param {object} shared `{ importPath, stem, seed, runs }`; `seed` may be null
 * @returns {string} the test file's text
 */
export function renderTest(lang, proposal, candidate, shared) {
  return RENDERERS[lang]({
    candidate,
    signatures: candidate.functions.map((name) =>
      proposal.signatures.find((sig) => sig.name === name),
    ),
    importPath: shared.importPath,
    stem: shared.stem,
    seed: shared.seed ?? derivedSeed(candidate.id),
    runs: shared.runs,
  });
}
