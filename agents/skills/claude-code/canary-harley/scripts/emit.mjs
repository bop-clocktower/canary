/**
 * canary-harley -- from confirmed candidate ids to the files to write.
 *
 * The plan is all-or-nothing: every id is resolved against the proposal
 * derived from the file as it is now, and every path is checked, before the
 * first byte is written. One bad id means zero files. An id whose signature
 * has changed since it was issued is not in that proposal, so the old
 * confirmation matches nothing.
 */
import { EXIT_ABSTAINED, fail } from './failure.mjs';
import { existingError, pathError, resolveOutDir } from './out-dir.mjs';
import { renderTest } from './render-test.mjs';
import { isIdentifier, resolveTargets, targetLang } from './targets.mjs';

function candidateError(proposal, lang, id, candidate) {
  if (candidate === undefined) {
    return fail(
      EXIT_ABSTAINED,
      `candidate ${id} is not derivable from ${proposal.source.path} as ` +
        'it is now. A signature may have changed since the id was issued; ' +
        'run propose again and confirm the new id.',
    );
  }
  if (!candidate.emittable) {
    return fail(
      EXIT_ABSTAINED,
      `candidate ${id} cannot be emitted: ${candidate.blocked.join('; ')}`,
    );
  }
  if (candidate.functions.every((name) => isIdentifier(lang, name))) {
    return null;
  }
  return fail(
    EXIT_ABSTAINED,
    `candidate ${id} cannot be emitted: a function name is not an identifier`,
  );
}

/** Each distinct id's candidate, or the first id that cannot be used. */
function resolveIds(proposal, lang, ids) {
  const candidates = [];
  for (const id of new Set(ids)) {
    const candidate = proposal.candidates.find((item) => item.id === id);
    const error = candidateError(proposal, lang, id, candidate);
    if (error !== null) return { candidates: [], error };
    candidates.push(candidate);
  }
  return { candidates, error: null };
}

/** The checks that need no candidate: the paths and the import. */
function resolveShared(opts) {
  const bad = pathError(opts);
  if (bad !== null) return { error: bad };
  const out = resolveOutDir(opts.root, opts.outDir);
  if (out.error !== null) return { error: out.error };
  const targets = resolveTargets(opts.file, opts.root, out.dir);
  if (targets.error !== null) return { error: targets.error };
  return { ...targets, seed: opts.seed, runs: opts.runs };
}

/**
 * @param {object} proposal the proposal derived from the file as it is now
 * @param {object} opts `{ ids, file, root, outDir, seed, runs, force }`;
 *   `file` and `root` are absolute, `outDir` and `seed` may be null
 * @returns {{ files: { path: string, text: string }[],
 *   error: { exit: number, message: string } | null }} every file, or none
 */
export function planEmit(proposal, opts) {
  const lang = targetLang(opts.file);
  const resolved = resolveIds(proposal, lang, opts.ids);
  if (resolved.error !== null) return { files: [], error: resolved.error };
  const shared = resolveShared(opts);
  if (shared.error !== null) return { files: [], error: shared.error };
  const files = resolved.candidates.map((candidate) => ({
    path: shared.pathFor(candidate),
    text: renderTest(lang, proposal, candidate, shared),
  }));
  const taken = existingError(files, opts.force);
  return taken === null ? { files, error: null } : { files: [], error: taken };
}
