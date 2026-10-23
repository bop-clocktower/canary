#!/usr/bin/env node
/**
 * Print the highest stable semver tag (`vMAJOR.MINOR.PATCH`) read from stdin.
 *
 * `release.yml`'s advance-latest job force-pushes the floating `latest` tag,
 * and it may only do that for the newest release (#1427). Its runs queue in the
 * order their publish finishes, not in tag order, so an older release that
 * finished later used to move `latest` backwards. The job pipes
 * `git tag --list 'v*'` here and advances only when the answer is its own tag.
 *
 * Why a script and not `sort -V`: version sort ranks `v1.0.0-rc.1` ABOVE
 * `v1.0.0`, the opposite of semver, and its handling of odd names varies by
 * platform. Here only an exact `vX.Y.Z` counts. Pre-releases (`-rc.1`), build
 * metadata (`+build`), `latest`, and anything else are ignored, and parts
 * compare as numbers, so `v1.10.0` outranks `v1.9.0`.
 *
 * Usage:   git tag --list 'v*' | node scripts/highest-stable-tag.mjs
 * Exit codes (#508): 0 printed a tag, 2 usage error (arguments given),
 * 3 ABSTENTION: no stable tag in the input, so nothing was ranked.
 */

import { readFileSync } from 'node:fs';

const STABLE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

if (process.argv.length > 2) {
  console.error(
    'usage: git tag --list | highest-stable-tag.mjs (reads stdin, takes no arguments)',
  );
  process.exit(2);
}

let best;
for (const raw of readFileSync(0, 'utf8').split('\n')) {
  const tag = raw.trim();
  const m = STABLE.exec(tag);
  if (!m) continue;
  const parts = m.slice(1).map(BigInt);
  if (!best || compare(parts, best.parts) > 0) best = { tag, parts };
}

if (!best) {
  console.error(
    'highest-stable-tag: no stable vX.Y.Z tag in the input (abstaining, exit 3)',
  );
  process.exit(3);
}
process.stdout.write(`${best.tag}\n`);

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
