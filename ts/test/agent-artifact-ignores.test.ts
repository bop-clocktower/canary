/**
 * Structural tests for the agent-tooling artifacts the skills-manager
 * extension writes into this repo.
 *
 * The extension drops ~2.6 MB of machine-local state across `.claude/`,
 * `.cursor/`, `.kiro/`, and `.github/` on every session. One of those files,
 * `.claude/mcp-usage.jsonl`, records absolute local paths, session IDs, and
 * full bash command strings — and this repo is public. The rest is per-machine
 * cost and adoption history that no clone should inherit.
 *
 * Guarding this in a test rather than trusting `.gitignore` to stay correct,
 * because the failure is silent in exactly the way #563 named: nobody reads a
 * clean `git status`, so the day a rule is reorganised away, the leak ships
 * green. The rules are also cwd-globbed (`**\/.claude/...`) rather than
 * path-listed, since the hooks resolve from the working directory — running a
 * command in `ts/` or `npm/` grows another copy.
 *
 * Offline: shells out to `git check-ignore` and `git ls-files` only. Never
 * writes, never reaches the network.
 *
 * The three invariants:
 *
 * 1. Every known artifact path is claimed by a `.gitignore` rule. Asserted per
 *    path so a partial regression names the path that slipped, and so the
 *    denominator is visible — a suite that checked zero paths would pass here
 *    and prove nothing.
 *
 * 2. The shared, tracked config is NOT ignored. A rule broad enough to catch
 *    the telemetry (`.claude/`) would also swallow `.claude/settings.json` and
 *    the 12 workflow files; this is the guard against over-correcting.
 *
 * 3. No artifact is tracked today. Covers the case invariant 1 cannot —
 *    `.gitignore` has no effect on an already-tracked file, so a stray
 *    `git add -f` would leave the rules correct and the leak live.
 */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Representative artifact paths, one per distinct rule plus the cwd-relative
 * duplicates that motivated globbing. These need not exist on disk —
 * `check-ignore` matches the path against the rules, not the filesystem.
 */
const ARTIFACT_PATHS = [
  // Telemetry stores — the PII-bearing ones.
  '.claude/learning/runs.jsonl',
  '.claude/mcp-usage.jsonl',
  // Same two files, re-created wherever a hook happened to run.
  'ts/.claude/mcp-usage.jsonl',
  'npm/.claude/mcp-usage.jsonl',
  '.github/workflows/.claude/mcp-usage.jsonl',
  '.github/workflows/.claude/learning/terminal-hook-state.json',
  // Per-vendor mirrors of the untracked local `.claude/skills/` set.
  '.cursor/hooks.json',
  '.cursor/skills/self-learning/SKILL.md',
  '.cursor/learning/cost-profile.json',
  '.kiro/learning/skill-stats.json',
  '.github/copilot-instructions.md',
  '.github/instructions/self-learning.instructions.md',
  '.github/hooks/claude-skills-budget.json',
  // harness CLI machine identity.
  'ts/.harness/.install-id',
  'agents/skills/.harness/.telemetry-notice-shown',
];

/** Shared config that must stay tracked and visible to every contributor. */
const MUST_STAY_TRACKED = [
  '.claude/settings.json',
  '.claude/settings.local.json.example',
  // Shared MCP server config. A blanket `.cursor/` rule swallows this; the
  // first run of this suite caught exactly that.
  '.cursor/mcp.json',
  '.github/workflows/harness.yml',
  '.github/workflows/dogfood.yml',
];

/** True when `.gitignore` claims `path`. */
function isIgnored(path: string): boolean {
  try {
    execFileSync('git', ['-C', REPO_ROOT, 'check-ignore', '-q', '--', path], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/** Every path git currently tracks under `prefix`. */
function trackedUnder(prefix: string): string[] {
  const out = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '--', prefix], {
    encoding: 'utf8',
  });
  return out.split('\n').filter(Boolean);
}

describe('agent-tooling artifacts stay out of the repo', () => {
  it('checks a non-empty set of artifact paths', () => {
    // A zero denominator is an abstention, not a pass.
    expect(ARTIFACT_PATHS.length).toBeGreaterThan(10);
  });

  it.each(ARTIFACT_PATHS)('ignores %s', (path) => {
    expect(isIgnored(path)).toBe(true);
  });

  it.each(MUST_STAY_TRACKED)('does not ignore shared config %s', (path) => {
    expect(isIgnored(path)).toBe(false);
  });

  it('keeps the tracked workflow set intact', () => {
    // `.github/hooks/` and `.github/instructions/` are ignored; the workflows
    // beside them must not be collateral.
    expect(trackedUnder('.github/workflows').length).toBeGreaterThanOrEqual(12);
  });

  it('tracks no telemetry or per-vendor mirror today', () => {
    const leaked = [
      ...trackedUnder('*.claude/learning'),
      ...trackedUnder('*.claude/mcp-usage.jsonl'),
      // Scoped to the extension-written subpaths — `.cursor/mcp.json` beside
      // them is shared config and is asserted tracked above.
      ...trackedUnder('.cursor/hooks.json'),
      ...trackedUnder('.cursor/learning'),
      ...trackedUnder('.cursor/skills'),
      ...trackedUnder('.kiro'),
      ...trackedUnder('.github/instructions'),
      ...trackedUnder('.github/hooks'),
      ...trackedUnder('.github/copilot-instructions.md'),
    ];
    expect(leaked).toEqual([]);
  });
});
