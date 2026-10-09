/**
 * Report and merge-base primitives for `scripts/docs-ratchet.mjs` (#1241).
 *
 * Split out for the same reason `perf-report.mjs` was (#850): the ratchet grew
 * past the 300-line threshold its own perf gate enforces. These turn files
 * into values, and refuse to turn an unreadable file into a pass.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Exit 3 (ADR 0009): nothing was verified, which is not a pass. */
export function abstain(why) {
  console.error(`docs-ratchet: ABSTAINED: ${why}`);
  process.exit(3);
}

/**
 * Parse a report, tolerating anything npx prints ahead of the JSON body.
 * Returns null when there is no usable `documented`/`undocumented` pair.
 */
export function readReport(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end < start) return null;
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const { documented, undocumented, scannedNothing } = parsed ?? {};
  if (!Array.isArray(documented) || !Array.isArray(undocumented)) return null;
  return {
    documented: new Set(documented),
    undocumented: new Set(undocumented),
    scannedNothing: scannedNothing === true,
  };
}

/**
 * The merge base's floor, or null for the one bootstrap case. Exits 3 when it
 * cannot verify. `path` is `<base tree>/.harness/docs-coverage-baseline.json`.
 *
 * Bootstrap is narrow on purpose: allowed only when the base has NO baseline
 * file AND its `scripts/docs-ratchet.mjs` is absent or never mentions the
 * floor, i.e. the base predates #1241. Any other missing or unreadable base
 * baseline is "cannot verify", which is a finding, not a skip.
 */
export function readBaseFloor(path) {
  let text = null;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    // Missing: decided below.
  }
  if (text === null) {
    const baseScript = join(dirname(path), '..', 'scripts', 'docs-ratchet.mjs');
    let script = '';
    try {
      script = readFileSync(baseScript, 'utf8');
    } catch {
      // A base with no ratchet at all predates the floor too.
    }
    if (!script.includes('minCoveragePercent')) return null;
    abstain(
      `merge base baseline ${path} is missing although the base ratchet ` +
        'enforces a floor, so a lowered floor cannot be ruled out.',
    );
  }
  let floor;
  try {
    floor = JSON.parse(text).minCoveragePercent;
  } catch {
    abstain(`merge base baseline ${path} is not JSON.`);
  }
  if (typeof floor !== 'number' || !Number.isFinite(floor)) {
    abstain(`merge base baseline ${path} has no numeric "minCoveragePercent".`);
  }
  return floor;
}

/**
 * Rule 3: the floor only rises. Compared against the MERGE BASE's baseline,
 * the one copy a PR cannot rewrite; comparing against HEAD would compare the
 * file with itself on a PR's merge ref.
 */
export function requireFloorNotLowered(floor, baseFloor) {
  if (baseFloor === null) {
    console.log(
      'docs-ratchet: BOOTSTRAP: the merge base predates the floor (no ' +
        'baseline, no floor in its ratchet); nothing to compare it against.',
    );
    return true;
  }
  if (floor < baseFloor) {
    console.error(
      `docs-ratchet: FAILED: the floor was LOWERED from ${baseFloor} at the ` +
        `merge base to ${floor}. A ratchet turns one way: link the new files ` +
        'from docs/ instead.',
    );
    return false;
  }
  return true;
}
