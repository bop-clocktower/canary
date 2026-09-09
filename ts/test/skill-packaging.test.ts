/**
 * The bundled-skill packaging contract (#757).
 *
 * `canary skills list` reported `No skills found.` from an installed
 * `canary-test-cli@7.1.0` -- from the repo root, from a clean worktree, and
 * from `agents/skills/claude-code/` itself, the directory holding 21 SKILL.md
 * files. It looked like a cwd bug and was not one: bundled discovery is
 * relative to the ENGINE's own location, never to the cwd, so no directory
 * could have changed the answer.
 *
 * The real cause was packaging. `SkillRegistry` resolves its bundled root three
 * directories above its compiled `core/` module, which is `<pkg>/agents/skills`
 * in the published layout -- and `npm/package.json#files` shipped `bin/` and
 * `dist/` only. The root the engine looked in had never existed in any install.
 *
 * That is two invariants, and losing either one reproduces the bug in a way the
 * other cannot catch:
 *
 * 1. The arithmetic. Three levels up from `dist/engine/core` is the package
 *    root, so the bundled root is `<pkg>/agents/skills`. Moving the compiled
 *    engine deeper (or shallower) inside the package silently retargets it.
 * 2. The shipment. `files` has to carry `agents/`, and the build has to stage
 *    it there. A correct path into a directory nobody publishes is the bug.
 *
 * Plus the case the issue explicitly asked for: a non-zero count from a
 * directory known to contain skills, so "zero" can never again be the only
 * observed outcome.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  SkillRegistry,
  bundledSkillsDirFrom,
} from '../src/core/skill-registry.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AGENTS_SKILLS = join(REPO_ROOT, 'agents', 'skills');

/** A home directory with no `.canary`, so only the bundled tier can answer. */
const EMPTY_HOME = join(REPO_ROOT, 'ts', 'test', 'fixtures', 'no-such-home');

interface NpmManifest {
  files?: string[];
}

const NPM_MANIFEST: NpmManifest = JSON.parse(
  readFileSync(join(REPO_ROOT, 'npm', 'package.json'), 'utf8'),
) as NpmManifest;

describe('bundled-skill root resolution', () => {
  it('lands on <pkg>/agents/skills from the PUBLISHED engine location', () => {
    // dist/engine/core is where build-engine.mjs stages the compiled core.
    const pkg = '/opt/lib/node_modules/canary-test-cli';
    expect(bundledSkillsDirFrom(join(pkg, 'dist', 'engine', 'core'))).toBe(
      join(pkg, 'agents', 'skills'),
    );
  });

  it('lands on <repo>/agents/skills from the SOURCE and COMPILED locations', () => {
    // The same arithmetic has to hold in all three layouts, which is why the
    // bug was invisible in a checkout: here it resolves correctly.
    for (const built of ['src', 'dist']) {
      expect(bundledSkillsDirFrom(join(REPO_ROOT, 'ts', built, 'core'))).toBe(
        AGENTS_SKILLS,
      );
    }
  });
});

describe('the published package ships the root the engine looks in', () => {
  it('declares agents/ in package.json#files', () => {
    // Without this the resolution above points at a directory npm never
    // published, which is exactly what 7.1.0 did.
    const files = NPM_MANIFEST.files ?? [];
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f === 'agents/' || f === 'agents')).toBe(true);
  });

  it('stages the skill tree during the engine build', () => {
    const build = readFileSync(
      join(REPO_ROOT, 'npm', 'scripts', 'build-engine.mjs'),
      'utf8',
    );
    expect(build).toContain('stageSkills');
    // The staging step counts what it copied and throws on zero, so a filter
    // that drops every SKILL.md fails the build instead of publishing the bug.
    expect(build).toContain('countSkillManifests');
  });
});

describe('discovery from a directory known to contain skills', () => {
  it('finds every bundled skill, and reports a non-zero count', () => {
    const skills = new SkillRegistry(EMPTY_HOME, AGENTS_SKILLS).discover(
      REPO_ROOT,
    );
    // The repo ships 21 nested skills plus the flat slash commands; asserting a
    // floor rather than an exact count keeps this from breaking on every new
    // skill while still refusing a zero.
    expect(skills.length).toBeGreaterThanOrEqual(21);
    expect(skills.some((s) => s.name === 'canary-cassandra')).toBe(true);
  });

  it('reports the bundled root as present when it is', () => {
    const roots = new SkillRegistry(EMPTY_HOME, AGENTS_SKILLS).searchRoots(
      REPO_ROOT,
    );
    const bundled = roots.find((r) => r.tier === 'bundled');
    expect(bundled?.path).toBe(AGENTS_SKILLS);
    expect(bundled?.exists).toBe(true);
  });

  it('reports a missing bundled root as missing, not as an empty one', () => {
    const roots = new SkillRegistry(
      EMPTY_HOME,
      join(REPO_ROOT, 'no', 'such', 'skills'),
    ).searchRoots(REPO_ROOT);
    expect(roots.find((r) => r.tier === 'bundled')?.exists).toBe(false);
    // Every tier is named, so a reader can see the whole denominator.
    expect(roots.map((r) => r.tier)).toEqual([
      'bundled',
      'overlay',
      'global',
      'local',
    ]);
  });

  it('renders the local tier as the ancestor range it swept', () => {
    const roots = new SkillRegistry(EMPTY_HOME, AGENTS_SKILLS).searchRoots(
      join(REPO_ROOT, 'agents', 'skills', 'claude-code'),
    );
    const local = roots.find((r) => r.tier === 'local');
    expect(local?.path).toContain('claude-code');
    expect(local?.path).toContain('up to the git root');
  });
});
