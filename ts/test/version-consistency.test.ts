/**
 * Version-consistency contract for the release surface.
 *
 * Ported from `tests/unit/test_version_consistency.py`. Guards a single
 * invariant: every machine-readable version declaration in the repo agrees on
 * one version string. The release bump is a manual step, and historically the
 * two `.claude-plugin/` manifests silently drifted (they sat at 4.0.0 through
 * the entire 5.x line).
 *
 * v6 note: `pyproject.toml` is being deleted as the repo goes Python-free, so
 * the pyproject accessor + its parity assertion are intentionally DROPPED. The
 * remaining cross-manifest parity across npm/package.json,
 * .claude-plugin/plugin.json, and .claude-plugin/marketplace.json (plus the
 * pre-release rule) is the release-bump guard and is preserved exactly.
 *
 * Scope note: README / brand-kit shields.io badges are *display* artifacts, not
 * canonical declarations, so they are intentionally out of scope here.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SEMVER = /^\d+\.\d+\.\d+([.-].+)?$/;

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf-8'));
}

function npmVersion(): string {
  return readJson('npm/package.json').version as string;
}

function pluginVersion(): string {
  return readJson('.claude-plugin/plugin.json').version as string;
}

function marketplaceVersion(): string {
  const data = readJson('.claude-plugin/marketplace.json') as {
    plugins: Array<{ name: string; version: string }>;
  };
  const canary = data.plugins.find((p) => p.name === 'canary');
  if (!canary) throw new Error('no plugin named "canary" in marketplace.json');
  return canary.version;
}

// (label, accessor) — package.json is the reference the others are compared to.
const SOURCES: Array<[string, () => string]> = [
  ['npm/package.json', npmVersion],
  ['.claude-plugin/plugin.json', pluginVersion],
  ['.claude-plugin/marketplace.json', marketplaceVersion],
];

describe('version consistency', () => {
  it('all versions are semver-shaped', () => {
    for (const [label, accessor] of SOURCES) {
      const version = accessor();
      expect(
        version,
        `${label} version '${version}' is not semver-shaped`,
      ).toMatch(SEMVER);
    }
  });

  it('all versions match (with pre-release rule)', () => {
    const npm = npmVersion();
    const plugin = pluginVersion();
    const marketplace = marketplaceVersion();

    // The two .claude-plugin manifests always agree with each other.
    expect(
      marketplace,
      `.claude-plugin/marketplace.json version '${marketplace}' != ` +
        `.claude-plugin/plugin.json version '${plugin}'.`,
    ).toBe(plugin);

    // The plugin schema forbids pre-release versions (^X.Y.Z$), and the
    // marketplace should only ever advertise a real release — so during an npm
    // PRE-RELEASE (e.g. 6.0.0-rc.1) the manifests stay at the last STABLE
    // release rather than tracking the pre-release. They must still be a stable
    // X.Y.Z; for a stable npm release all three match exactly.
    if (npm.includes('-')) {
      expect(
        plugin,
        `.claude-plugin version '${plugin}' must be a stable X.Y.Z ` +
          `while npm is a pre-release ('${npm}').`,
      ).toMatch(/^\d+\.\d+\.\d+$/);
    } else {
      expect(
        plugin,
        `.claude-plugin version '${plugin}' != npm/package.json version ` +
          `'${npm}' — bump every version declaration together ` +
          `(see chore(release) workflow).`,
      ).toBe(npm);
    }
  });
});
