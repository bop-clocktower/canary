/**
 * Baseline-side checks for `scripts/entropy-ratchet.mjs` (#744, #1247).
 *
 * Split out for the same reason `docs-coverage.mjs` was (#1241): the ratchet
 * sat at 299 lines, one under the 300-line threshold its own perf gate
 * enforces. These compare the baseline with something it cannot vouch for
 * itself, the instrument that produced the report and the merge base's copy of
 * the file, and refuse to turn "cannot verify" into a pass.
 */

import { readFileSync } from 'node:fs';

/** Print and exit with a gate code (ADR 0009). */
export function fail(code, message) {
  console.error(message);
  process.exit(code);
}

/**
 * Abstain unless the CLI that produced this report is the one the ceiling was
 * calibrated against (#744). Twin of the same function in `perf-ratchet.mjs`.
 *
 * The count is only meaningful next to the identity of the analyzer that
 * produced it, and the workflows pin a FLOATING major, so that analyzer changes
 * with no commit here. It moved twice: 11.1.1 -> 11.2.0 took the count
 * 281 -> 257, and 11.2.0 -> 11.3.0 took it 257 -> 147 while the ceiling stood
 * at 267. Every offline guard stayed green through both, because they compare
 * the baseline against itself and a floating minor clears a MAJOR check by
 * construction.
 *
 * A disagreement is an ABSTENTION, never a pass and never a failure: the
 * measurement is not comparable to the ceiling, so there is nothing to compare.
 * Re-measure, and update the baseline in the same PR.
 */
export function requireMatchingInstrument(
  baselineCli,
  cliVersion,
  maxFindings,
  findings,
) {
  if (baselineCli === null || cliVersion === baselineCli) return;
  fail(
    3,
    `entropy-ratchet: ABSTAINED — this baseline's ${maxFindings} ceiling was ` +
      `calibrated against harness CLI ${baselineCli}, but ` +
      (cliVersion === null
        ? 'the caller did not say which version produced this report ' +
          '(pass `--cli-version`).'
        : `this report was produced by ${cliVersion}.`) +
      `\nThe measured ${findings} is therefore not comparable to the ` +
      'ceiling — an analyzer that changes its own false-positive model moves ' +
      'this count with no change to the codebase, in either direction.\n' +
      'Re-measure in a clean worktree and update "measuredCount" and ' +
      '"harnessCli" in the baseline in the SAME PR. Do not silence this by ' +
      'deleting "harnessCli".',
  );
}

function abstainOnBase(path, why) {
  fail(
    3,
    `entropy-ratchet: ABSTAINED — merge base baseline ${path} ${why}, so a ` +
      'raised ceiling cannot be ruled out. "Cannot verify" is not a pass.',
  );
}

/**
 * The merge base's `maxFindings`, or exit 3. `path` is
 * `<base tree>/.harness/entropy-baseline.json`.
 *
 * No bootstrap exemption, unlike the docs floor: main has carried this file
 * since #544, so a missing copy means the base worktree or the path is wrong.
 */
function readBaseCeiling(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    abstainOnBase(path, `cannot be read (${err.code ?? err.message})`);
  }
  let ceiling;
  try {
    ceiling = JSON.parse(text).maxFindings;
  } catch {
    abstainOnBase(path, 'is not JSON');
  }
  if (!Number.isInteger(ceiling)) {
    abstainOnBase(path, 'has no integer "maxFindings"');
  }
  return ceiling;
}

/**
 * The ceiling only falls (#1247). Compared against the MERGE BASE's baseline,
 * the one copy a PR cannot rewrite. The guard this replaces compared the file
 * with `git show HEAD:`, which on a PR's merge ref is the same file, so a
 * committed raise passed it. `basePath` is the base's copy, `path` the head's.
 */
export function requireCeilingNotRaised(maxFindings, basePath, path) {
  const baseCeiling = readBaseCeiling(basePath);
  if (maxFindings > baseCeiling) {
    fail(
      1,
      `entropy-ratchet: FAILED — the ceiling was RAISED from ${baseCeiling} ` +
        `at the merge base to ${maxFindings} in ${path}.\n` +
        'A ratchet turns one way (#544): raising "maxFindings" is the one move ' +
        'that is never right. Fix the new findings, or declare a false-positive ' +
        'entry point in `entropy.entryPoints` in harness.config.json. If the ' +
        'ANALYZER moved rather than the code, record the new "harnessCli" and ' +
        'leave the ceiling where it is.',
    );
  }
  console.log(
    `entropy-ratchet: ceiling OK — ${maxFindings} here, ${baseCeiling} at ` +
      'the merge base.',
  );
}
