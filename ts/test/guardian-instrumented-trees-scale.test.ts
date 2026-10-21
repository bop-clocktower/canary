/**
 * `instrumentedTrees` (#883) must stay linear in the number of report entries.
 *
 * It groups report paths by top-level directory, and rebuilding each group's
 * array with a spread on every entry made the grouping quadratic: a report of
 * a few tens of thousands of files under one `src/` — an ordinary monorepo —
 * stalls the guardian gate for seconds per call, and the orchestrator calls it
 * twice per run.
 *
 * The test asserts the growth SHAPE, not a wall-clock budget (#1402). A fixed
 * millisecond bound measured the runner as much as the code: under v8 coverage
 * on a shared runner it went red at 1059 ms on a deps-only PR. Ten times the
 * input costs ~10x for a linear grouping and ~100x for a quadratic one, so the
 * ratio of the two sizes separates the shapes on any machine, at any speed,
 * with or without coverage instrumentation. Each size is warmed up once and
 * then timed as the minimum of several repetitions, so one GC pause or runner
 * hiccup cannot inflate either side of the ratio.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { instrumentedTrees } from '../src/guardian/diff-coverage/report-anchor.js';
import {
  selfDescribing,
  type ReportIndex,
} from '../src/guardian/diff-coverage/types.js';

const SMALL = 10_000;
const LARGE = 100_000;
const REPETITIONS = 7;
/** Linear is ~10x; quadratic is ~100x. 15x leaves room for noise on both. */
const MAX_RATIO = 15;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'canary-trees-scale-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** `n` report entries under one top-level tree — the shape that regressed. */
function reportOf(n: number): ReportIndex {
  const index: ReportIndex = Object.create(null);
  for (let i = 0; i < n; i++) index[`src/f${i}.ts`] = selfDescribing({ 1: 1 });
  return index;
}

/** Milliseconds for one `instrumentedTrees` call over `index`. */
function timeOnce(index: ReportIndex): number {
  const started = performance.now();
  instrumentedTrees(index, join(root, 'lcov.info'), root);
  return performance.now() - started;
}

describe('instrumentedTrees scale', () => {
  it('grows linearly: 10x the entries costs well under 100x the time', () => {
    const smallIndex = reportOf(SMALL);
    const largeIndex = reportOf(LARGE);
    timeOnce(smallIndex);
    timeOnce(largeIndex);
    // Interleaved, so a stretch of runner contention lands on both sizes
    // rather than on whichever one happened to be sampled during it.
    let small = Infinity;
    let large = Infinity;
    for (let r = 0; r < REPETITIONS; r++) {
      small = Math.min(small, timeOnce(smallIndex));
      large = Math.min(large, timeOnce(largeIndex));
    }
    const ratio = large / small;
    expect(
      ratio,
      `time(${LARGE})/time(${SMALL}) = ${large.toFixed(1)}ms / ` +
        `${small.toFixed(1)}ms = ${ratio.toFixed(1)}x`,
    ).toBeLessThanOrEqual(MAX_RATIO);
  }, 120_000);
});
