/**
 * A coverage report rooted in one package must not verify a same-named file in
 * a sibling package.
 *
 * A vitest run under `pkg-a/` writes repo-relative-to-`pkg-a` paths such as
 * `src/index.ts`. The report tier's boundary-suffix match then binds a changed
 * `pkg-b/src/index.ts` to that record — one candidate, so the ambiguity guard
 * never fires — and grades a file nothing tested as COVERAGE_VERIFIED from
 * another package's hit counts. The report tier already knows the report's
 * anchor (`anchorPrefix`, #883); matching never consults it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  Fidelity,
  resolveCoverage,
  resolveCoverageDelta,
  resolveCoverageWithInput,
} from '../src/guardian/coverage.js';

let root: string;

function write(rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body, 'utf-8');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'canary-cross-pkg-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('report tier: cross-package suffix binding', () => {
  it("does not verify pkg-b/src/index.ts from pkg-a's report record", () => {
    write('pkg-a/src/index.ts', 'export const a = 1;\n');
    write('pkg-b/src/index.ts', 'export const b = 2;\n');
    // pkg-a's own report: its paths are rooted at pkg-a/.
    write(
      'pkg-a/coverage/lcov.info',
      'SF:src/index.ts\nDA:1,5\nend_of_record\n',
    );

    const [result] = resolveCoverage(
      [{ path: 'pkg-b/src/index.ts', added_ranges: [[1, 1]] }],
      {
        coveragePath: join(root, 'pkg-a/coverage/lcov.info'),
        graphPath: join(root, 'no-graph.json'),
        repoRoot: root,
      },
    );

    // pkg-a's hit count says nothing about pkg-b's file.
    expect(result!.fidelity).not.toBe(Fidelity.CoverageVerified);
  });

  it('counts the sibling-package unit as unmatched, not matched', () => {
    // Ported from repro/bf-a3-cross-package-suffix-bind: the false bind also
    // inflated the report's matched count the gate reports to the operator.
    write('ts/src/index.ts', 'x\n');
    write('web/src/index.ts', 'y\n');
    write('ts/coverage/lcov.info', 'SF:src/index.ts\nDA:1,1\nend_of_record\n');

    const { coverage } = resolveCoverageWithInput(
      [{ path: 'web/src/index.ts', added_ranges: [[1, 1]] }],
      {
        coveragePath: join(root, 'ts/coverage/lcov.info'),
        graphPath: join(root, 'no-graph.json'),
        repoRoot: root,
      },
    );

    expect(coverage.unitsMatched).toBe(0);
  });

  it("still verifies the owning package's file from its own report", () => {
    // The positive: anchoring must not cost the match the report is FOR.
    write('pkg-a/src/index.ts', 'export const a = 1;\n');
    write('pkg-b/src/index.ts', 'export const b = 2;\n');
    write(
      'pkg-a/coverage/lcov.info',
      'SF:src/index.ts\nDA:1,5\nend_of_record\n',
    );

    const [result] = resolveCoverage(
      [{ path: 'pkg-a/src/index.ts', added_ranges: [[1, 1]] }],
      {
        coveragePath: join(root, 'pkg-a/coverage/lcov.info'),
        graphPath: join(root, 'no-graph.json'),
        repoRoot: root,
      },
    );

    expect(result!.fidelity).toBe(Fidelity.CoverageVerified);
    expect(result!.covered).toBe(true);
  });

  it("never compares a sibling-package file against pkg-a's delta", () => {
    write('pkg-a/src/index.ts', 'export const a = 1;\n');
    write('pkg-b/src/index.ts', 'export const b = 2;\n');
    write(
      'pkg-a/coverage/base.info',
      'SF:src/index.ts\nDA:1,5\nend_of_record\n',
    );
    write(
      'pkg-a/coverage/head.info',
      'SF:src/index.ts\nDA:1,0\nend_of_record\n',
    );

    const { deltas, state } = resolveCoverageDelta(
      [{ path: 'pkg-b/src/index.ts', added_ranges: [[1, 1]] }],
      {
        baseCoveragePath: join(root, 'pkg-a/coverage/base.info'),
        headCoveragePath: join(root, 'pkg-a/coverage/head.info'),
        repoRoot: root,
      },
    );

    // pkg-a's drop is not a regression in pkg-b.
    expect(state.unitsCompared).toBe(0);
    expect(deltas).toEqual([]);
  });

  it("does not verify a root-level src/index.ts from pkg-a's report record", () => {
    // Before anchoring this bound by EXACT match (raw key `src/index.ts`);
    // anchored to `pkg-a/src/index.ts` it must not bind by suffix instead.
    write('pkg-a/src/index.ts', 'export const a = 1;\n');
    write('src/index.ts', 'export const root = 0;\n');
    write(
      'pkg-a/coverage/lcov.info',
      'SF:src/index.ts\nDA:1,5\nend_of_record\n',
    );

    const [result] = resolveCoverage(
      [{ path: 'src/index.ts', added_ranges: [[1, 1]] }],
      {
        coveragePath: join(root, 'pkg-a/coverage/lcov.info'),
        graphPath: join(root, 'no-graph.json'),
        repoRoot: root,
      },
    );

    expect(result!.fidelity).not.toBe(Fidelity.CoverageVerified);
  });

  it('keeps an entry exact-only after continuation folding binds its owner', () => {
    // The owning unit's match folds continuation lines into its entry; the
    // folded copy must stay anchored, or the next unit suffix-binds it.
    write('pkg-a/src/index.ts', 'export const a = 1;\n');
    write('src/index.ts', 'export const root = 0;\n');
    write(
      'pkg-a/coverage/lcov.info',
      'SF:src/index.ts\nDA:1,5\nend_of_record\n',
    );

    const [owner, rootFile] = resolveCoverage(
      [
        { path: 'pkg-a/src/index.ts', added_ranges: [[1, 1]] },
        { path: 'src/index.ts', added_ranges: [[1, 1]] },
      ],
      {
        coveragePath: join(root, 'pkg-a/coverage/lcov.info'),
        graphPath: join(root, 'no-graph.json'),
        repoRoot: root,
      },
    );

    expect(owner!.fidelity).toBe(Fidelity.CoverageVerified);
    expect(rootFile!.fidelity).not.toBe(Fidelity.CoverageVerified);
  });
});
