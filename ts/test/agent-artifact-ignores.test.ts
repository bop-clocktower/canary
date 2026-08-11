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
 * A second batch of these paths — the personal skill installs and Claude Code's
 * runtime state — previously hid in `.git/info/exclude`, which is machine-local
 * and never shared, so a fresh clone or a second laptop saw them as untracked
 * while the first machine looked clean. Consolidating them here is what makes
 * the two agree; asserting them here is what keeps them agreeing. This suite
 * deliberately does NOT assert anything about `.git/info/exclude` itself —
 * it is a legitimate per-developer tool, and a test that forbade it would
 * false-fail on any contributor who uses it as intended.
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
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { reportAbstention } from './abstention-testkit';

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
  // Personal skill installs — third-party artifacts carrying a
  // `.skill-version.json` receipt, not this project's source.
  '.claude/skills/terraform-plan-review/SKILL.md',
  '.claude/skills/skill-creator/LICENSE.txt',
  // Claude Code runtime state. `worktrees/` is a live checkout of in-flight
  // branches; the rest is regenerated per machine.
  '.claude/worktrees/linter-exclude-strict-pragma/README.md',
  '.claude/checkpoints/some-checkpoint.json',
  '.claude/mailbox/some-message.json',
  '.claude/routines/.state/state.json',
  '.claude/scheduled_tasks.json',
  '.claude/agent-registry.json',
  '.claude/agent-memory-local',
  '.claude/assistant-daemon-state.json',
  '.claude/first-run',
  '.claude/position.local.json',
  '.claude/profile.local.json',
  // Globbed, so a nested checkout is covered too.
  'ts/.claude/worktrees/some-branch/file.ts',
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

/**
 * Paths that need not exist yet but must stay *committable* — an ignore rule
 * broad enough to catch them would foreclose something silently.
 */
const MUST_STAY_COMMITTABLE = [
  // A project skill authored for this repo. `.claude/skills/` is ignored by
  // named install, never wholesale, precisely so this path stays open.
  '.claude/skills/a-project-skill/SKILL.md',
];

/** Where personal skill installs land. Absent on a fresh clone and in CI. */
const SKILLS_DIR = join(REPO_ROOT, '.claude', 'skills');

/**
 * Local skill directories paired with whether they carry an install receipt.
 * `null` when the directory does not exist at all — which is the normal case
 * in CI, and is reported rather than silently passing.
 */
function localSkillDirs(): Array<{ name: string; installed: boolean }> | null {
  if (!existsSync(SKILLS_DIR)) return null;
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({
      name: e.name,
      installed: existsSync(join(SKILLS_DIR, e.name, '.skill-version.json')),
    }));
}

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
    expect(ARTIFACT_PATHS.length).toBeGreaterThan(25);
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
      ...trackedUnder('.claude/worktrees'),
      // `.claude/skills` is deliberately absent: a project skill authored for
      // this repo belongs there and should be trackable. The install/authored
      // split is enforced by receipt below, not by a blanket path rule.
    ];
    expect(leaked).toEqual([]);
  });

  it.each(MUST_STAY_COMMITTABLE)('leaves %s committable', (path) => {
    expect(isIgnored(path)).toBe(false);
  });
});

/**
 * The install-vs-authored split, enforced from the filesystem rather than a
 * hardcoded list, so it stays true as skills are installed and written.
 *
 * `.gitignore` cannot express "ignore directories containing a receipt", so
 * the rule is a list of names and this is what keeps the list honest. Both
 * directions matter, and they fail for opposite reasons:
 *
 *   - An INSTALLED skill (has `.skill-version.json`) that is not ignored means
 *     the next `git add -A` vendors a third party's code into a public repo.
 *   - An AUTHORED skill (no receipt) that IS ignored means someone's own work
 *     silently never appears in `git status`. That is the failure this file
 *     was rewritten to prevent — a blanket `.claude/skills/` rule caused it.
 */
describe('local skill installs are ignored; authored skills are not', () => {
  const dirs = localSkillDirs();

  it('reports whether the guard could run at all', () => {
    // `.claude/skills/` is a local install location that does not exist on a
    // fresh clone or in CI. Zero directories is an abstention, not a pass, so
    // say which case this run is rather than reporting a silent green. The
    // named-install rules themselves are still covered by ARTIFACT_PATHS
    // above, which is checkout-independent.
    if (dirs === null) {
      // Via the testkit, not `console.warn`: the default reporter discards
      // console output from passing tests, so this notice printed nothing on
      // every CI run since it was written (#650).
      reportAbstention(
        'skills guard',
        '.claude/skills/ absent — receipt classification not exercised on ' +
          'this checkout (expected in CI).',
      );
    }
    expect(dirs === null || dirs.length > 0).toBe(true);
  });

  const cases = dirs ?? [];
  it.skipIf(cases.length === 0).each(cases)(
    '$name is ignored iff it carries an install receipt',
    ({ name, installed }: { name: string; installed: boolean }) => {
      const ignored = isIgnored(`.claude/skills/${name}/SKILL.md`);
      if (installed) {
        expect(
          ignored,
          `.claude/skills/${name}/ carries a .skill-version.json receipt, so ` +
            'it is a third-party install. Add it to .gitignore beside the ' +
            'other installs, or it will be committed on the next `git add -A`.',
        ).toBe(true);
      } else {
        expect(
          ignored,
          `.claude/skills/${name}/ has no .skill-version.json, so it reads as ` +
            'a project skill authored for this repo — but .gitignore is ' +
            'hiding it, and it will never show up in `git status`. Remove ' +
            'its .gitignore entry so it can be committed.',
        ).toBe(false);
      }
    },
  );
});
