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
  resolveFromReport,
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
    expect(result!.fidelity).toBe(Fidelity.Heuristic);
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

    expect(result!.fidelity).toBe(Fidelity.Heuristic);
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
    expect(rootFile!.fidelity).toBe(Fidelity.Heuristic);
  });

  it("does not verify pkg-b/src/index.ts from a repo-root report's record", () => {
    // A report rooted at the repo itself anchors at prefix '': its key is
    // already the repo path, so it too must bind by exact match only. #1415:
    // `src/index.ts` exists at the root AND under pkg-b, so the report path
    // cannot say which one it measured; the root file fails closed too.
    write('src/index.ts', 'export const root = 0;\n');
    write('pkg-b/src/index.ts', 'export const b = 2;\n');
    write('coverage/lcov.info', 'SF:src/index.ts\nDA:1,5\nend_of_record\n');

    const [rootFile, sibling] = resolveCoverage(
      [
        { path: 'src/index.ts', added_ranges: [[1, 1]] },
        { path: 'pkg-b/src/index.ts', added_ranges: [[1, 1]] },
      ],
      {
        coveragePath: join(root, 'coverage/lcov.info'),
        graphPath: join(root, 'no-graph.json'),
        repoRoot: root,
      },
    );

    expect(rootFile!.fidelity).toBe(Fidelity.Heuristic);
    expect(sibling!.fidelity).toBe(Fidelity.Heuristic);
  });
});

describe('public resolveFromReport with a repo root (#1414)', () => {
  it("does not verify a sibling package's same-named file", () => {
    write('pkg-a/src/index.ts', 'export const a = 1;\n');
    write('pkg-b/src/index.ts', 'export const b = 2;\n');
    write(
      'pkg-a/coverage/lcov.info',
      'SF:src/index.ts\nDA:1,5\nend_of_record\n',
    );

    const results = resolveFromReport(
      [{ path: 'pkg-b/src/index.ts', added_ranges: [[1, 1]] }],
      join(root, 'pkg-a/coverage/lcov.info'),
      root,
    );

    // No result: the unit falls through to a lower tier, never verified.
    expect(results).toEqual([]);
  });

  it("still verifies the owning package's file", () => {
    write('pkg-a/src/index.ts', 'export const a = 1;\n');
    write('pkg-b/src/index.ts', 'export const b = 2;\n');
    write(
      'pkg-a/coverage/lcov.info',
      'SF:src/index.ts\nDA:1,5\nend_of_record\n',
    );

    const [result] = resolveFromReport(
      [{ path: 'pkg-a/src/index.ts', added_ranges: [[1, 1]] }],
      join(root, 'pkg-a/coverage/lcov.info'),
      root,
    )!;

    expect(result!.fidelity).toBe(Fidelity.CoverageVerified);
    expect(result!.covered).toBe(true);
  });
});

describe('a root coverage/ report whose key names several packages (#1415)', () => {
  const report = 'SF:src/index.ts\nDA:1,5\nend_of_record\n';
  const opts = () => ({
    coveragePath: join(root, 'coverage/lcov.info'),
    graphPath: join(root, 'no-graph.json'),
    repoRoot: root,
  });

  it('does not verify the never-instrumented pkg-b/src/index.ts', () => {
    // vitest ran in pkg-a with reportsDirectory ../coverage.
    write('pkg-a/src/index.ts', 'export const a = 1;\n');
    write('pkg-b/src/index.ts', 'export const b = 2;\n');
    write('coverage/lcov.info', report);

    const [result] = resolveCoverage(
      [{ path: 'pkg-b/src/index.ts', added_ranges: [[1, 1]] }],
      opts(),
    );

    expect(result!.fidelity).not.toBe(Fidelity.CoverageVerified);
  });

  it('fails closed for every candidate, the producing package included', () => {
    // The report path cannot say which package wrote the key, so neither
    // candidate may claim its hit counts.
    write('pkg-a/src/index.ts', 'export const a = 1;\n');
    write('pkg-b/src/index.ts', 'export const b = 2;\n');
    write('coverage/lcov.info', report);

    const results = resolveFromReport(
      [
        { path: 'pkg-a/src/index.ts', added_ranges: [[1, 1]] },
        { path: 'pkg-b/src/index.ts', added_ranges: [[1, 1]] },
      ],
      join(root, 'coverage/lcov.info'),
      root,
    );

    expect(results).toEqual([]);
  });

  it("does not verify a root src/index.ts from a package's record", () => {
    // Root-file variant: the key also exists at the repo root, so it anchors
    // there by exact match; the root file must not take pkg-a's hit counts.
    write('pkg-a/src/index.ts', 'export const a = 1;\n');
    write('src/index.ts', 'export const root = 0;\n');
    write('coverage/lcov.info', report);

    const [rootFile, pkgA] = resolveCoverage(
      [
        { path: 'src/index.ts', added_ranges: [[1, 1]] },
        { path: 'pkg-a/src/index.ts', added_ranges: [[1, 1]] },
      ],
      opts(),
    );

    expect(rootFile!.fidelity).toBe(Fidelity.Heuristic);
    expect(pkgA!.fidelity).toBe(Fidelity.Heuristic);
  });

  it('still verifies a key that exists under exactly one package', () => {
    write('pkg-a/src/index.ts', 'export const a = 1;\n');
    write('pkg-b/src/other.ts', 'export const b = 2;\n');
    write('coverage/lcov.info', report);

    const [result] = resolveCoverage(
      [{ path: 'pkg-a/src/index.ts', added_ranges: [[1, 1]] }],
      opts(),
    );

    expect(result!.fidelity).toBe(Fidelity.CoverageVerified);
    expect(result!.covered).toBe(true);
  });
});
