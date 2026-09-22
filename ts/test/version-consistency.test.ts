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
 *
 * Denominator note (#1059): `npm/package-lock.json` sat outside SOURCES, so a
 * lockfile stale by two releases survived green — the gate passed because it
 * never looked. The lockfile declares the version twice (root and
 * `packages[""]`) and both are now in the denominator, alongside a check that
 * the lock's root entry still mirrors the manifest's dependency declarations.
 *
 * Encoding note (#1064): parity between version FIELDS says nothing about the
 * rest of the bytes the bump rewrites. A byte-level fixed-point check on a
 * no-op bump is added below, because the JSON round-trip was silently
 * re-encoding `npm/package.json`'s escaped em dash on every release.
 *
 * `ts/package-lock.json` is deliberately NOT here: `ts/package.json` is the
 * private workspace, pinned at 0.0.0 and never published, so it has no release
 * version to agree with. That is an explicit exemption, not an oversight —
 * asserted below so the omission cannot be mistaken for coverage.
 */

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SEMVER = /^\d+\.\d+\.\d+([.-].+)?$/;

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf-8'));
}

/** The first line that differs between two files, for a readable failure. */
function firstDiffLine(before: Buffer, after: Buffer): string {
  const a = before.toString('utf-8').split('\n');
  const b = after.toString('utf-8').split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return `line ${i + 1}\n  before: ${a[i] ?? '(absent)'}\n  after:  ${b[i] ?? '(absent)'}`;
    }
  }
  return '(no line differs — trailing bytes only)';
}

function npmVersion(): string {
  return readJson('npm/package.json').version as string;
}

function pluginVersion(): string {
  return readJson('.claude-plugin/plugin.json').version as string;
}

/** The lockfile declares the version twice; both must agree with the manifest. */
function npmLockRootVersion(): string {
  return readJson('npm/package-lock.json').version as string;
}

function npmLockPackageVersion(): string {
  const packages = readJson('npm/package-lock.json').packages as Record<
    string,
    { version?: string }
  >;
  const root = packages[''];
  if (!root) throw new Error('npm/package-lock.json has no root ("") package');
  return root.version as string;
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
  ['npm/package-lock.json (root)', npmLockRootVersion],
  ['npm/package-lock.json (packages[""])', npmLockPackageVersion],
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

  it('npm/package-lock.json agrees with npm/package.json', () => {
    const npm = npmVersion();
    for (const [label, accessor] of [
      ['npm/package-lock.json (root)', npmLockRootVersion],
      ['npm/package-lock.json (packages[""])', npmLockPackageVersion],
    ] as Array<[string, () => string]>) {
      expect(
        accessor(),
        `${label} version '${accessor()}' != npm/package.json version ` +
          `'${npm}' — regenerate the lockfile as part of the release bump ` +
          `(scripts/bump-version.mjs stamps it).`,
      ).toBe(npm);
    }
  });

  it("lockfile root entry mirrors the manifest's dependency declarations", () => {
    // The #1059 drift was two-headed: a stale version AND a peerDependency
    // present in the manifest but absent from the lock. Version parity alone
    // would not have caught the second, so the declarations are compared too.
    const manifest = readJson('npm/package.json');
    const packages = readJson('npm/package-lock.json').packages as Record<
      string,
      Record<string, unknown>
    >;
    const lockRoot = packages[''];
    if (!lockRoot) throw new Error('npm/package-lock.json has no root package');

    const MIRRORED = [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'peerDependenciesMeta',
      'engines',
    ] as const;
    // `bin` is deliberately absent: npm normalises './bin/x' to 'bin/x' when
    // it writes the lock, so the two disagree by design and comparing them
    // would be a permanent false positive.

    for (const field of MIRRORED) {
      expect(
        lockRoot[field] ?? null,
        `npm/package-lock.json packages[""].${field} does not match ` +
          `npm/package.json ${field} — run ` +
          '`npm install --package-lock-only` in npm/.',
      ).toEqual(manifest[field] ?? null);
    }
  });

  it('the denominator is non-empty and names every gated manifest', () => {
    // A zero denominator is an abstention, not a pass. Pin the expected set so
    // dropping a source from SOURCES fails loudly instead of silently
    // shrinking what "all versions match" means.
    expect(SOURCES.map(([label]) => label)).toEqual([
      'npm/package.json',
      '.claude-plugin/plugin.json',
      '.claude-plugin/marketplace.json',
      'npm/package-lock.json (root)',
      'npm/package-lock.json (packages[""])',
    ]);
  });

  // #1064: version parity says nothing about what ELSE the bump writes.
  // `npm/package.json` stores its description with an escaped `—`, and
  // the bump's JSON.parse/JSON.stringify round-trip wrote it back as a literal
  // em dash — so every release commit carried an unrelated one-line encoding
  // change. The invariant is byte-level: a bump to the version already in the
  // tree must leave every stamped file untouched.
  describe('a no-op bump is byte-for-byte a fixed point (#1064)', () => {
    const STAMPED = [
      'npm/package.json',
      'npm/package-lock.json',
      '.claude-plugin/plugin.json',
      '.claude-plugin/marketplace.json',
      'README.md',
    ];

    // The script derives its repo root from its own location, so the whole
    // surface is mirrored into a sandbox — the real tree is never written to.
    const sandbox = mkdtempSync(join(tmpdir(), 'canary-bump-'));
    afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

    for (const rel of [...STAMPED, 'scripts/bump-version.mjs']) {
      mkdirSync(join(sandbox, dirname(rel)), { recursive: true });
      copyFileSync(join(REPO_ROOT, rel), join(sandbox, rel));
    }

    const before = new Map(
      STAMPED.map((rel) => [rel, readFileSync(join(sandbox, rel))]),
    );

    execFileSync(
      process.execPath,
      [join(sandbox, 'scripts/bump-version.mjs'), npmVersion()],
      { stdio: 'pipe' },
    );

    it.each(STAMPED)('%s is unchanged', (rel) => {
      const after = readFileSync(join(sandbox, rel));
      expect(
        after.equals(before.get(rel)!),
        `${rel} changed during a no-op bump — scripts/bump-version.mjs is ` +
          `re-encoding it (see #1064). Diff of the first mismatch:\n` +
          `${firstDiffLine(before.get(rel)!, after)}`,
      ).toBe(true);
    });
  });

  it('ts/package-lock.json is exempt because ts/ is never published', () => {
    // Recorded rather than assumed: the exemption holds only while ts/ is a
    // private, unpublished workspace pinned at 0.0.0. If that ever changes,
    // this fails and the lockfile has to join the denominator above.
    const tsPkg = readJson('ts/package.json');
    expect(
      tsPkg.private,
      'ts/package.json is no longer private — it now needs version gating.',
    ).toBe(true);
    expect(
      tsPkg.version,
      'ts/package.json is no longer pinned at 0.0.0 — it now needs version ' +
        'gating alongside npm/package.json.',
    ).toBe('0.0.0');
  });
});
