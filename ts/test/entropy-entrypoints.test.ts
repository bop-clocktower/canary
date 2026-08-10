/**
 * Class-level structural tests for `entropy.entryPoints` in
 * `harness.config.json` (#544).
 *
 * Sibling of `harness-config-denominator.test.ts`, and the same failure class
 * one layer down: **a configured rule that matches nothing still reports as
 * configured.** There the vacuous thing was a layer pattern; here it is the
 * root of the dead-code reachability graph.
 *
 * The instance: `entryPoints` was `["ts/bin/canary.js"]`. `bin` and `dist` are
 * both members of the harness analyzer's `DEFAULT_SKIP_DIRS`, so that file was
 * never in the scanned snapshot at all — and neither was `../dist/cli.js`, the
 * only thing it imports. The reachability walk started from an empty set, so
 * every scanned non-test source file in the repo came back unreachable: 175 of
 * 175, reported as 770 findings. Nothing about that output looks like an
 * abstention. It looks like a very messy codebase, which is exactly why it sat
 * unexamined.
 *
 * Three invariants, none of which requires running `harness`:
 *
 * 1. Every declared entry point is a git-tracked file. A path that does not
 *    exist contributes nothing to the graph and raises the dead-code count
 *    silently.
 *
 * 2. No entry point lives under a directory the analyzer skips by default
 *    (`bin/`, `dist/`, `build/`, `out/`, `coverage/`, `node_modules/`, ...).
 *    This is the exact bug. A build artifact is never a valid root, because
 *    the scanner refuses to look at build artifacts.
 *
 * 3. Entry points are literal paths, not globs. The schema takes
 *    `z.array(z.string())` and resolves each as a path — a `scripts/*.mjs`
 *    entry silently matches nothing, which looks identical to a correct config
 *    right up until every script in the directory is reported dead. Verified
 *    empirically against the v11 CLI before this rule was written.
 *
 * Offline: reads `harness.config.json` and asks git for its index.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The subset of the analyzer's `DEFAULT_SKIP_DIRS` that a canary entry point
 * could plausibly be pointed at by mistake. Kept short and readable rather than
 * mirroring the upstream set wholesale: this is a tripwire, not a replica, and
 * a copy of a 50-entry constant would rot the first time upstream edits it.
 */
const SKIPPED_DIRS = [
  'bin',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  'node_modules',
  'vendor',
  '.next',
  '.cache',
];

interface HarnessConfig {
  entropy?: { entryPoints?: string[] };
}

function readConfig(): HarnessConfig {
  return JSON.parse(
    readFileSync(join(REPO_ROOT, 'harness.config.json'), 'utf8'),
  ) as HarnessConfig;
}

function trackedFiles(): Set<string> {
  const out = execFileSync('git', ['ls-files'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return new Set(out.split('\n').filter(Boolean));
}

describe('entropy.entryPoints', () => {
  const entryPoints = readConfig().entropy?.entryPoints ?? [];

  // Guard the guard: an empty list would satisfy every "for each entry" rule
  // below without checking anything, which is the abstention shape all over
  // again. Auto-detection is not an acceptable fallback here — it is what the
  // repo had before, and it produced the 770.
  it('declares entry points at all', () => {
    expect(entryPoints.length).toBeGreaterThan(0);
  });

  it('points every entry at a git-tracked file', () => {
    const tracked = trackedFiles();
    const missing = entryPoints.filter((p) => !tracked.has(p));
    expect(missing).toEqual([]);
  });

  it('keeps every entry out of a directory the analyzer skips', () => {
    const skipped = entryPoints.filter((p) =>
      p.split('/').some((seg) => SKIPPED_DIRS.includes(seg)),
    );
    expect(skipped).toEqual([]);
  });

  it('uses literal paths, never globs', () => {
    const globbed = entryPoints.filter((p) => /[*?[\]{}]/.test(p));
    expect(globbed).toEqual([]);
  });

  // The reachability graph is only as good as its roots. Every package that
  // ships or runs code needs at least one, or its whole tree reads as dead.
  it('covers every source root that has its own execution surface', () => {
    for (const root of ['ts/src/', 'npm/src/', 'scripts/', 'hooks/']) {
      expect(
        entryPoints.some((p) => p.startsWith(root)),
        `no entry point under ${root}`,
      ).toBe(true);
    }
  });
});
