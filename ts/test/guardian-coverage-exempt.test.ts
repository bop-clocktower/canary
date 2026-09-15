/**
 * #883 / ADR 0024 decisions 3 and 4 — `canary.guardian.coverageExempt`.
 *
 * A tree recorded as coverage-exempt leaves the coverage-tier denominator but
 * is still judged at the graph and heuristic tiers, and the skip is disclosed
 * with its count and globs, never presented as a coverage pass (#508).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type ChangedUnit,
  type CoverageInputState,
  resolveCoverageWithInput,
} from '../src/guardian/coverage.js';
import {
  coverageExemptMatcher,
  loadGuardianConfig,
  renderFindings,
} from '../src/guardian/pr-check.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'guardian-exempt-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const HEAD = '## \u{1F424} Canary PR Guardian \u{2014} ';
const IN_TREE: ChangedUnit = {
  path: 'ts/src/guardian/diff-extractor.ts',
  added_ranges: [[120, 121]],
};
const SCRIPT: ChangedUnit = {
  path: 'scripts/lib/example.mjs',
  added_ranges: [[1, 5]],
};

function lcov(): string {
  const path = join(tmp, 'lcov.info');
  writeFileSync(
    path,
    'SF:ts/src/guardian/diff-extractor.ts\nDA:120,1\nDA:121,1\nend_of_record\n',
    'utf-8',
  );
  return path;
}

function resolve(units: ChangedUnit[], globs: string[]) {
  return resolveCoverageWithInput(units, {
    coveragePath: lcov(),
    graphPath: join(tmp, 'missing-graph.json'),
    repoRoot: tmp,
    coverageExempt: coverageExemptMatcher(globs),
  });
}

const comment = (coverage: CoverageInputState): string =>
  renderFindings([], 'comment', 0, null, {
    checked: coverage.unitsTotal,
    abstained: false,
    coverage,
  });

const headline = (body: string): string =>
  body.split('\n').find((l) => l.startsWith('## '))!;

describe('loadGuardianConfig: coverageExempt', () => {
  it('defaults to no exemptions when the key is absent', () => {
    const cfg = join(tmp, 'harness.config.json');
    writeFileSync(cfg, JSON.stringify({ canary: { guardian: { pr: {} } } }));
    expect(loadGuardianConfig(cfg)[0].coverage_exempt).toEqual([]);
  });

  it('reads bare globs and {glob, reason} entries', () => {
    const cfg = join(tmp, 'harness.config.json');
    writeFileSync(
      cfg,
      JSON.stringify({
        canary: {
          guardian: {
            coverageExempt: [
              'agents/skills/**',
              { glob: 'scripts/**', reason: 'no lcov; #883' },
            ],
          },
        },
      }),
    );
    const [config, warning] = loadGuardianConfig(cfg);
    expect(warning).toBeNull();
    expect(config.coverage_exempt).toEqual([
      { glob: 'agents/skills/**', reason: null },
      { glob: 'scripts/**', reason: 'no lcov; #883' },
    ]);
  });

  it('warns on an entry with no glob instead of dropping it silently', () => {
    const cfg = join(tmp, 'harness.config.json');
    writeFileSync(
      cfg,
      JSON.stringify({
        canary: { guardian: { coverageExempt: [{ reason: 'x' }] } },
      }),
    );
    const [config, warning] = loadGuardianConfig(cfg);
    expect(config.coverage_exempt).toEqual([]);
    expect(warning).toContain('coverageExempt');
  });
});

describe('resolveCoverageWithInput: exempt units leave the coverage denominator', () => {
  it('counts exempt units apart and names the globs that matched', () => {
    const { coverage, results } = resolve(
      [IN_TREE, SCRIPT],
      ['scripts/**', 'agents/skills/**'],
    );
    expect(coverage.unitsTotal).toBe(1);
    expect(coverage.unitsMatched).toBe(1);
    expect(coverage.unitsExempt).toBe(1);
    expect(coverage.exemptGlobs).toEqual(['scripts/**']);
    // Still judged below the coverage tier: one result per unit.
    expect(results).toHaveLength(2);
    expect(results[1]!.unit.path).toBe(SCRIPT.path);
  });

  it('without exemptions the same unit is a scope gap, as before', () => {
    const { coverage } = resolve([IN_TREE, SCRIPT], []);
    expect(coverage.unitsTotal).toBe(2);
    expect(coverage.unitsExempt ?? 0).toBe(0);
  });
});

describe('disclosure (#508): a skip is counted, never a pass', () => {
  it('an all-exempt PR reports a named skip, not ✅ and not "nothing to test"', () => {
    const { coverage } = resolve([SCRIPT], ['scripts/**']);
    const body = comment(coverage);
    expect(headline(body)).toBe(
      `${HEAD}\u{26A0}\u{FE0F} coverage skipped: 1 file coverage-exempt (scripts/**)`,
    );
    expect(body).not.toContain('\u{2705}');
  });

  it('a mixed PR keeps its verdict and lists the exempt count underneath', () => {
    const { coverage } = resolve([IN_TREE, SCRIPT], ['scripts/**']);
    const body = comment(coverage);
    expect(body).toContain('- 1 file: skipped as coverage-exempt (scripts/**)');
    expect(headline(body)).not.toContain('\u{2705}');
  });
});
