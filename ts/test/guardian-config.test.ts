/**
 * Faithful TypeScript port of `tests/unit/test_guardian_config.py`.
 *
 * The loader reads the `canary.guardian` block from `harness.config.json` via
 * {@link readJsonWithWarning}, so a malformed file surfaces a loud warning
 * instead of silently degrading to defaults (SC-8).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type ChangedUnit } from '../src/guardian/coverage.js';
import {
  GuardianConfig,
  effectiveGraphDepth,
  filterSkipped,
  loadGuardianConfig,
} from '../src/guardian/pr-check.js';

// Local literal to catch drift against the module's DEFAULT_SKIP_GLOBS, exactly
// like the Python test keeps its own copy.
const DEFAULT_SKIP_GLOBS = [
  'docs/**',
  '**/*.md',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/poetry.lock',
  '**/Cargo.lock',
  '**/*.lock',
  'dist/**',
  'build/**',
  '**/*.min.js',
  '**/*.snap',
  'agents/commands/**',
  '.harness/**',
  '**/.harness/**',
  '**/.*',
  '**/*.config.js',
  '**/*.config.ts',
  '**/*.config.mjs',
  '**/*.config.cjs',
  '**/fixtures/**',
  '**/__fixtures__/**',
  '**/__mocks__/**',
  '**/testdata/**',
  '**/generated/**',
  '**/__generated__/**',
];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canary-gconfig-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(obj: unknown): string {
  const cfg = join(dir, 'harness.config.json');
  writeFileSync(cfg, JSON.stringify(obj), 'utf-8');
  return cfg;
}

// ---------------------------------------------------------------------------
// loadGuardianConfig
// ---------------------------------------------------------------------------

describe('loadGuardianConfig', () => {
  it('valid block parsed', () => {
    const cfg = write({
      canary: {
        guardian: {
          pr: { enabled: false, tier: 2, gate: 'hard' },
          preCommit: { enabled: true, authorTests: false, gate: 'hard' },
          coveragePaths: ['coverage.json'],
          skipGlobs: ['docs/**', '*.md'],
        },
      },
    });
    const [config, warning] = loadGuardianConfig(cfg);
    expect(warning).toBeNull();
    expect(config).toBeInstanceOf(GuardianConfig);
    expect(config.pr_enabled).toBe(false);
    expect(config.pr_tier).toBe(2);
    expect(config.pr_gate).toBe('hard');
    expect(config.precommit_enabled).toBe(true);
    expect(config.precommit_author_tests).toBe(false);
    expect(config.precommit_gate).toBe('hard');
    expect(config.coverage_paths).toEqual(['coverage.json']);
    expect(config.skip_globs).toEqual(['docs/**', '*.md']);
  });

  it('malformed JSON warns and defaults', () => {
    const cfg = join(dir, 'harness.config.json');
    writeFileSync(cfg, '{ this is not json ', 'utf-8');
    const [config, warning] = loadGuardianConfig(cfg);
    expect(warning).not.toBeNull(); // SC-8: loud, not silent
    expect(config).toEqual(new GuardianConfig());
  });

  it('absent file → silent defaults', () => {
    const [config, warning] = loadGuardianConfig(join(dir, 'nope.json'));
    expect(warning).toBeNull();
    expect(config).toEqual(new GuardianConfig());
  });

  it('valid file without block → silent defaults', () => {
    const cfg = write({ something: 'else' });
    const [config, warning] = loadGuardianConfig(cfg);
    expect(warning).toBeNull();
    expect(config).toEqual(new GuardianConfig());
  });

  it('defaults', () => {
    const c = new GuardianConfig();
    expect(c.pr_enabled).toBe(true);
    expect(c.pr_tier).toBe(0);
    expect(c.pr_gate).toBe('soft');
    expect(c.precommit_enabled).toBe(false);
    expect(c.precommit_author_tests).toBe(false);
    expect(c.coverage_paths).toEqual([]);
    expect(c.graph_coverage_max_depth).toBeNull();
    expect(c.skip_globs).toEqual(DEFAULT_SKIP_GLOBS);
  });

  it('non-int tier warns and defaults (FIX 4)', () => {
    const cfg = write({ canary: { guardian: { pr: { tier: 'medium' } } } });
    const [config, warning] = loadGuardianConfig(cfg);
    expect(warning).not.toBeNull();
    expect(config.pr_tier).toBe(new GuardianConfig().pr_tier);
  });

  it('fractional tier warns and defaults (FIX 4)', () => {
    const cfg = write({ canary: { guardian: { pr: { tier: 1.5 } } } });
    const [config, warning] = loadGuardianConfig(cfg);
    expect(warning).not.toBeNull();
    expect(config.pr_tier).toBe(new GuardianConfig().pr_tier);
  });

  it('unknown gate warns and defaults (FIX 4)', () => {
    const cfg = write({ canary: { guardian: { pr: { gate: 'banana' } } } });
    const [config, warning] = loadGuardianConfig(cfg);
    expect(warning).not.toBeNull();
    expect(config.pr_gate).toBe(new GuardianConfig().pr_gate); // default "soft"
  });

  it('list tier warns and defaults (FIX 4)', () => {
    const cfg = write({ canary: { guardian: { pr: { tier: [] } } } });
    const [config, warning] = loadGuardianConfig(cfg);
    expect(warning).not.toBeNull();
    expect(config.pr_tier).toBe(new GuardianConfig().pr_tier);
  });

  it('list gate does not flatten to "hard" — warns + defaults soft', () => {
    // FIX 3: `String(["hard"])` is "hard" (would wrongly enforce); Python
    // `str(["hard"])` is "['hard']" and is rejected. Guard keeps them aligned.
    const cfg = write({ canary: { guardian: { pr: { gate: ['hard'] } } } });
    const [config, warning] = loadGuardianConfig(cfg);
    expect(warning).not.toBeNull();
    expect(config.pr_gate).toBe('soft'); // default, NOT enforced
    // FIX 4: the warn text reprs the list Python-style.
    expect(warning).toContain("['hard']");
  });

  it('list graphCoverageMaxDepth warns + defaults null', () => {
    // FIX 3: `["2"]` must not be coerced to 2 — Python `int(str(["2"]))` raises.
    const cfg = write({
      canary: { guardian: { graphCoverageMaxDepth: ['2'] } },
    });
    const [config, warning] = loadGuardianConfig(cfg);
    expect(warning).not.toBeNull();
    expect(config.graph_coverage_max_depth).toBeNull();
  });

  it('graphCoverageMaxDepth parsed (#320)', () => {
    const cfg = write({ canary: { guardian: { graphCoverageMaxDepth: 2 } } });
    const [config, warning] = loadGuardianConfig(cfg);
    expect(warning).toBeNull();
    expect(config.graph_coverage_max_depth).toBe(2);
  });

  it('bad graphCoverageMaxDepth warns and defaults (#320/SC-8)', () => {
    const cfg = write({ canary: { guardian: { graphCoverageMaxDepth: 'x' } } });
    const [config, warning] = loadGuardianConfig(cfg);
    expect(warning).not.toBeNull();
    expect(config.graph_coverage_max_depth).toBeNull();
  });

  it('non-positive graphCoverageMaxDepth warns and defaults (#320 FIX 2)', () => {
    for (const bad of [0, -3]) {
      const cfg = write({
        canary: { guardian: { graphCoverageMaxDepth: bad } },
      });
      const [config, warning] = loadGuardianConfig(cfg);
      expect(config.graph_coverage_max_depth, `${bad}`).toBeNull();
      expect(warning, `${bad}`).not.toBeNull();
    }
  });

  it('valid positive graphCoverageMaxDepth → no warning', () => {
    const cfg = write({ canary: { guardian: { graphCoverageMaxDepth: 2 } } });
    const [config, warning] = loadGuardianConfig(cfg);
    expect(config.graph_coverage_max_depth).toBe(2);
    expect(warning).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// skipGlobs default (FIX B + signal-quality)
// ---------------------------------------------------------------------------

describe('skipGlobs default', () => {
  it('absent key falls back to default globs', () => {
    const cfg = write({ canary: { guardian: { pr: { gate: 'hard' } } } });
    const [config, warning] = loadGuardianConfig(cfg);
    expect(warning).toBeNull();
    expect(config.skip_globs).toEqual(DEFAULT_SKIP_GLOBS);
  });

  it('explicit empty list overrides default', () => {
    const cfg = write({ canary: { guardian: { skipGlobs: [] } } });
    const [config, warning] = loadGuardianConfig(cfg);
    expect(warning).toBeNull();
    expect(config.skip_globs).toEqual([]);
  });

  it('explicit globs used verbatim', () => {
    const cfg = write({ canary: { guardian: { skipGlobs: ['build/**'] } } });
    const [config, warning] = loadGuardianConfig(cfg);
    expect(warning).toBeNull();
    expect(config.skip_globs).toEqual(['build/**']);
  });

  it('no block uses default globs', () => {
    const cfg = write({ something: 'else' });
    const [config] = loadGuardianConfig(cfg);
    expect(config.skip_globs).toEqual(DEFAULT_SKIP_GLOBS);
  });

  it('generated command artifact skipped by default (PR #325)', () => {
    const config = new GuardianConfig();
    const unit: ChangedUnit = {
      path: 'agents/commands/gemini-cli/harness/canary-pr-guardian.toml',
      added_ranges: [[1, 5]],
    };
    const [kept, skipped] = filterSkipped([unit], config.skip_globs);
    expect(kept).toEqual([]);
    expect(skipped.map((u) => u.path)).toEqual([unit.path]);
  });

  it('harness state skipped by default', () => {
    const config = new GuardianConfig();
    const unit: ChangedUnit = {
      path: '.harness/skills-index.json',
      added_ranges: [[1, 3]],
    };
    const [kept, skipped] = filterSkipped([unit], config.skip_globs);
    expect(kept).toEqual([]);
    expect(skipped.map((u) => u.path)).toEqual([unit.path]);
  });
});

// ---------------------------------------------------------------------------
// effectiveGraphDepth (#320)
// ---------------------------------------------------------------------------

describe('effectiveGraphDepth', () => {
  it('hard gate defaults to direct edge', () => {
    expect(effectiveGraphDepth(new GuardianConfig(), 'hard')).toBe(1);
  });

  it('soft gate defaults to unbounded', () => {
    expect(effectiveGraphDepth(new GuardianConfig(), 'soft')).toBeNull();
  });

  it('explicit override wins over gate', () => {
    const config = new GuardianConfig({ graph_coverage_max_depth: 3 });
    expect(effectiveGraphDepth(config, 'hard')).toBe(3);
    expect(effectiveGraphDepth(config, 'soft')).toBe(3);
  });
});
