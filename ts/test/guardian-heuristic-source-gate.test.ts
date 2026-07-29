/**
 * #413 — the heuristic tier must not manufacture coverage gaps on non-source
 * paths.
 *
 * The Tier-3 heuristic asks "does any test file reference this file's stem or a
 * top-level symbol?". For a config dotfile, a lockfile, or a generated artifact
 * there are no symbols and no test will ever name it, so the answer is
 * STRUCTURALLY always "no" — a guaranteed false positive rather than a signal.
 *
 * That FP is doubly expensive: it trains reviewers to ignore the sticky comment,
 * and every 👎 adjudication drives `precision = TP / (TP + FP)` down, so a repo
 * that routinely touches config can be held below its promotion bar forever even
 * when its coverage-verified findings are excellent.
 *
 * The gate is deliberately narrow — it suppresses ONLY the uncovered *heuristic*
 * verdict. A coverage-verified or graph-verified finding on the same path is
 * real evidence and still fires.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ChangedUnit,
  CoverageResult,
  Fidelity,
  isSourcePath,
} from '../src/guardian/coverage.js';
import {
  DEFAULT_HEURISTIC_EXCLUDE_GLOBS,
  filterHeuristicNoise,
  loadGuardianConfig,
} from '../src/guardian/pr-check.js';
import { invokeGuardian, mkTmp, rmTmp } from './guardian-cli-testkit.js';

function unit(path: string): ChangedUnit {
  return { path, added_ranges: [[1, 3]] };
}

function result(
  path: string,
  fidelity: Fidelity,
  covered = false,
): CoverageResult {
  return {
    unit: unit(path),
    covered,
    fidelity,
    evidence: 'x',
    uncovered_lines: [],
  };
}

// --- isSourcePath -------------------------------------------------------------

describe('isSourcePath (#413)', () => {
  it.each([
    'src/app.ts',
    'src/app.tsx',
    'pkg/widget.py',
    'lib/thing.go',
    'cmd/main.rs',
    'app/models/user.rb',
    'scripts/deploy.sh',
    'src/App.vue',
  ])('treats %s as source', (path) => {
    expect(isSourcePath(path)).toBe(true);
  });

  it.each([
    'path/to/service.config',
    '.eslintrc',
    '.eslintrc.json',
    'Makefile',
    'Dockerfile',
    'data/seed.json',
    'ci/pipeline.yaml',
    'styles/main.css',
    'public/index.html',
    'assets/logo.svg',
    'db/0001_init.sql',
    'go.sum',
  ])('treats %s as non-source', (path) => {
    expect(isSourcePath(path)).toBe(false);
  });
});

// --- filterHeuristicNoise -----------------------------------------------------

describe('filterHeuristicNoise (#413)', () => {
  it('drops an uncovered heuristic verdict on a non-source path', () => {
    const results = [result('path/to/service.config', Fidelity.Heuristic)];
    const [kept, dropped] = filterHeuristicNoise(results, []);

    expect(kept).toEqual([]);
    expect(dropped.map((r) => r.unit.path)).toEqual(['path/to/service.config']);
  });

  it('KEEPS a coverage-verified verdict on the same non-source path', () => {
    // Real evidence (an lcov row) beats the extension gate — the suppression is
    // scoped to the heuristic tier alone, not to the path.
    const results = [
      result('path/to/service.config', Fidelity.CoverageVerified),
      result('path/to/service.config', Fidelity.GraphVerified),
    ];
    const [kept, dropped] = filterHeuristicNoise(results, []);

    expect(kept.length).toBe(2);
    expect(dropped).toEqual([]);
  });

  it('keeps an uncovered heuristic verdict on a source path', () => {
    const results = [result('src/widget.ts', Fidelity.Heuristic)];
    const [kept, dropped] = filterHeuristicNoise(results, []);

    expect(kept.length).toBe(1);
    expect(dropped).toEqual([]);
  });

  it('leaves COVERED heuristic verdicts alone (they raise no finding)', () => {
    const results = [
      result('path/to/service.config', Fidelity.Heuristic, true),
    ];
    const [kept, dropped] = filterHeuristicNoise(results, []);

    expect(kept.length).toBe(1);
    expect(dropped).toEqual([]);
  });

  it('drops a source path matched by an exclude glob', () => {
    const results = [
      result('src/api/__generated__/client.ts', Fidelity.Heuristic),
    ];
    const [kept, dropped] = filterHeuristicNoise(results, [
      '**/__generated__/**',
    ]);

    expect(kept).toEqual([]);
    expect(dropped.length).toBe(1);
  });

  it('excludes ambient type declarations by default', () => {
    // `.d.ts` carries a source extension but no runtime behavior to test.
    expect(DEFAULT_HEURISTIC_EXCLUDE_GLOBS).toContain('**/*.d.ts');
    const results = [result('src/types/global.d.ts', Fidelity.Heuristic)];
    const [kept] = filterHeuristicNoise(results, [
      ...DEFAULT_HEURISTIC_EXCLUDE_GLOBS,
    ]);

    expect(kept).toEqual([]);
  });
});

// --- config -------------------------------------------------------------------

describe('heuristicExclude config (#413)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkTmp();
  });
  afterEach(() => {
    rmTmp(tmp);
  });

  function writeConfig(guardian: Record<string, unknown>): string {
    const path = join(tmp, 'harness.config.json');
    writeFileSync(
      path,
      JSON.stringify({ canary: { guardian } }, null, 2),
      'utf-8',
    );
    return path;
  }

  it('defaults to the built-in exclude list when absent', () => {
    const cfg = writeConfig({ pr: { gate: 'soft' } });
    const [config] = loadGuardianConfig(cfg);

    expect(config.heuristic_exclude).toEqual([
      ...DEFAULT_HEURISTIC_EXCLUDE_GLOBS,
    ]);
  });

  it('honors an explicit list verbatim', () => {
    const cfg = writeConfig({ pr: { heuristicExclude: ['**/*.mock.ts'] } });
    const [config] = loadGuardianConfig(cfg);

    expect(config.heuristic_exclude).toEqual(['**/*.mock.ts']);
  });

  it('honors an explicit empty list as "exclude nothing"', () => {
    const cfg = writeConfig({ pr: { heuristicExclude: [] } });
    const [config] = loadGuardianConfig(cfg);

    expect(config.heuristic_exclude).toEqual([]);
  });
});

// --- CLI wiring ---------------------------------------------------------------

const DIFF_CONFIG_AND_SRC = `diff --git a/path/to/service.config b/path/to/service.config
index 1111111..2222222 100644
--- a/path/to/service.config
+++ b/path/to/service.config
@@ -0,0 +1,2 @@
+timeout=30
+retries=3
diff --git a/src/widget.ts b/src/widget.ts
index 3333333..4444444 100644
--- a/src/widget.ts
+++ b/src/widget.ts
@@ -0,0 +1,3 @@
+export function widget() {
+  return 42;
+}
`;

describe('pr-check heuristic FP suppression (#413)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkTmp();
    mkdirSync(join(tmp, 'src'), { recursive: true });
    mkdirSync(join(tmp, 'path', 'to'), { recursive: true });
    writeFileSync(
      join(tmp, 'src', 'widget.ts'),
      'export function widget() {\n  return 42;\n}\n',
      'utf-8',
    );
    writeFileSync(
      join(tmp, 'path', 'to', 'service.config'),
      'timeout=30\nretries=3\n',
      'utf-8',
    );
  });
  afterEach(() => {
    rmTmp(tmp);
  });

  it('flags the source file but not the config file', async () => {
    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--format', 'json'],
      { input: DIFF_CONFIG_AND_SRC, cwd: tmp },
    );

    expect(res.code).toBe(0);
    const paths = JSON.parse(res.stdout).findings.map(
      (f: { path: string }) => f.path,
    );
    expect(paths).toContain('src/widget.ts');
    expect(paths).not.toContain('path/to/service.config');
  });

  it('counts a suppressed heuristic path as skipped, not verified', async () => {
    const diffConfigOnly = DIFF_CONFIG_AND_SRC.split('diff --git a/src')[0]!;
    const res = await invokeGuardian(['pr-check', '--diff', '-'], {
      input: diffConfigOnly,
      cwd: tmp,
    });

    expect(res.code).toBe(0);
    expect(res.stdout).toContain('nothing to verify');
    expect(res.stdout).toContain('1 path(s) skipped');
  });

  it('--heuristic-exclude suppresses an ad-hoc source path', async () => {
    const res = await invokeGuardian(
      [
        'pr-check',
        '--diff',
        '-',
        '--format',
        'json',
        '--heuristic-exclude',
        'src/**',
      ],
      { input: DIFF_CONFIG_AND_SRC, cwd: tmp },
    );

    // Both units are now heuristic-ineligible (`src/**` by flag, the `.config`
    // by the extension floor), so there is nothing scorable left — reported as
    // a SKIP of 2 paths rather than an empty "everything passed" report.
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('nothing to verify');
    expect(res.stdout).toContain('2 path(s) skipped');
  });

  it('an explicit empty config list restores the pre-#413 behavior', async () => {
    const cfg = join(tmp, 'harness.config.json');
    writeFileSync(
      cfg,
      JSON.stringify({
        canary: { guardian: { pr: { heuristicExclude: [] } } },
      }),
      'utf-8',
    );
    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--config', cfg, '--format', 'json'],
      { input: DIFF_CONFIG_AND_SRC, cwd: tmp },
    );

    // The extension gate is the built-in floor and is NOT config-defeatable:
    // an empty exclude list only clears the glob layer.
    const paths = JSON.parse(res.stdout).findings.map(
      (f: { path: string }) => f.path,
    );
    expect(paths).not.toContain('path/to/service.config');
  });
});
