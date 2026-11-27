/**
 * canary-harley -- from a source text and its function names to signatures
 * and ranked candidates.
 *
 * Names outside the CRUD/UI boundary are skipped before they are read, and a
 * file in a language harley does not read yields nothing rather than a guess.
 */
import { boundarySkip } from './cues.mjs';
import { deriveCandidates } from './invariants.mjs';
import { langOf, readSignatures } from './signatures.mjs';

function partition(names) {
  const reasons = names.map((name) => ({ name, reason: boundarySkip(name) }));
  return {
    kept: reasons.filter((row) => row.reason === null).map((row) => row.name),
    skipped: reasons.filter((row) => row.reason !== null),
  };
}

function read(source, lang, names) {
  if (lang === null) return { signatures: [], skipped: [] };
  return readSignatures(source, lang, names);
}

function filterOnly(candidates, only) {
  if (only === null) return candidates;
  return candidates.filter((candidate) => candidate.functions.includes(only));
}

/**
 * @param {string} file the source path; its extension picks the language
 * @param {string} source the file's text
 * @param {string[]} names the functions the engine's extractor found
 * @param {string | null} only keep only this function's candidates
 * @returns {{ lang: string | null, kept: string[], skipped: object[],
 *   signatures: object[], candidates: object[] }}
 */
export function deriveFrom(file, source, names, only) {
  const lang = langOf(file);
  const split = partition(names);
  const result = read(source, lang, split.kept);
  return {
    lang,
    kept: split.kept,
    skipped: [...split.skipped, ...result.skipped],
    signatures: result.signatures,
    candidates: filterOnly(deriveCandidates(result.signatures), only),
  };
}
