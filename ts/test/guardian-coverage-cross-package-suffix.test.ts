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

import { Fidelity, resolveCoverage } from '../src/guardian/coverage.js';

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
});
