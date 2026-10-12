/**
 * `instrumentedTrees` (#883) must stay linear in the number of report entries.
 *
 * It groups report paths by top-level directory, and rebuilding each group's
 * array with a spread on every entry made the grouping quadratic: a report of
 * a few tens of thousands of files under one `src/` — an ordinary monorepo —
 * stalls the guardian gate for seconds per call, and the orchestrator calls it
 * twice per run. The bound below is ~20x the linear cost and roughly a tenth
 * of the quadratic cost, so it separates the two shapes without being a
 * micro-benchmark.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { instrumentedTrees } from '../src/guardian/diff-coverage/report-tier.js';
import {
  selfDescribing,
  type ReportIndex,
} from '../src/guardian/diff-coverage/types.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'canary-trees-scale-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('instrumentedTrees scale', () => {
  it('groups 100k report entries under one tree in under 1s', () => {
    const index: ReportIndex = Object.create(null);
    for (let i = 0; i < 100_000; i++) {
      index[`src/f${i}.ts`] = selfDescribing({ 1: 1 });
    }
    const started = performance.now();
    instrumentedTrees(index, join(root, 'lcov.info'), root);
    expect(performance.now() - started).toBeLessThan(1000);
  }, 120_000);
});
