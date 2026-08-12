/**
 * The repo root is not a gate surface (#672).
 *
 * #672 was filed as "the root `package.json` has a `lint` script targeting
 * `agent/`, a tree deleted in the v6.0.0 cutover". Investigating it turned up
 * the sharper fact: **there is no root `package.json` in this repository.** It
 * has been gitignored since #244 (`/package.json`, `/package-lock.json`) as
 * per-machine markdownlint scratch — CI runs `npx --yes markdownlint-cli` and
 * never installs a root node project. Any root manifest a contributor is
 * looking at is a local file that no review, no CI job, and no ratchet has ever
 * seen, which is exactly how one came to carry `ruff check agent tests` months
 * after `agent/` was deleted.
 *
 * So the fix is not a script edit — it is pinning the invariants that make the
 * root unmistakably gate-free, and saying so in `AGENTS.md`. A `npm run lint`
 * at the root is the false-green shape from
 * `docs/knowledge/gates/false-green-detection.md`: a command whose success or
 * failure describes nothing about the codebase.
 *
 * Offline: reads tracked paths via `git ls-files` and parses committed files.
 * Never installs, never runs a gate.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The four gates, exactly as `ts/package.json` names them. */
const GATE_SCRIPTS = ['build', 'typecheck', 'format:check', 'test'] as const;

interface Manifest {
  scripts?: Record<string, string>;
}

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split('\n').filter(Boolean);
}

function readManifest(relPath: string): Manifest {
  return JSON.parse(readFileSync(join(REPO_ROOT, relPath), 'utf8')) as Manifest;
}

const TRACKED = trackedFiles();
const TRACKED_MANIFESTS = TRACKED.filter((p) => p.endsWith('package.json'));
const AGENTS_MD = readFileSync(join(REPO_ROOT, 'AGENTS.md'), 'utf8');

describe('repo root', () => {
  // Denominator guard: every assertion below is read off this list, so an empty
  // one would pass the whole file while checking nothing.
  it('has manifests to check at all', () => {
    expect(TRACKED_MANIFESTS.length).toBeGreaterThan(0);
  });

  it('tracks no manifest of its own', () => {
    const atRoot = TRACKED_MANIFESTS.filter((p) => !p.includes('/'));
    expect(atRoot).toEqual([]);
  });

  it('tracks no lockfile of its own', () => {
    expect(TRACKED.filter((p) => p === 'package-lock.json')).toEqual([]);
  });

  // Without these two lines a stray local manifest is one `git add -A` from
  // becoming a real root gate surface that nothing above would have caught
  // until after it landed.
  it('keeps both root node paths gitignored', () => {
    const gitignore = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8');
    const lines = gitignore.split('\n').map((l) => l.trim());
    expect(lines).toContain('/package.json');
    expect(lines).toContain('/package-lock.json');
  });
});

describe('tracked manifests', () => {
  // `ruff` is a Python linter and the Python engine was deleted in v6.0.0.
  // A manifest that still shells out to it is linting an empty set at best.
  it.each(TRACKED_MANIFESTS)('%s runs no Python tooling', (relPath) => {
    const scripts = readManifest(relPath).scripts ?? {};
    const python = Object.entries(scripts).filter(([, cmd]) =>
      /\bruff\b|\bpytest\b|\bmypy\b/.test(cmd),
    );
    expect(python).toEqual([]);
  });

  it.each(TRACKED_MANIFESTS)('%s points no script at agent/', (relPath) => {
    const scripts = readManifest(relPath).scripts ?? {};
    const dead = Object.entries(scripts).filter(([, cmd]) =>
      /(^|[\s"'])agent\//.test(cmd),
    );
    expect(dead).toEqual([]);
  });

  it('has no agent/ tree left for a script to point at', () => {
    expect(existsSync(join(REPO_ROOT, 'agent'))).toBe(false);
  });
});

describe('the four gates', () => {
  const tsScripts = readManifest('ts/package.json').scripts ?? {};

  it.each(GATE_SCRIPTS)('ts/package.json declares %s', (name) => {
    expect(Object.keys(tsScripts)).toContain(name);
  });

  // The gate list is closed on purpose. `lint` is the name that keeps getting
  // reached for; there is no linter here (no ESLint by decision, and the
  // `protect-config` hook blocks AI-authored linter configs), so a `lint`
  // script would be a name with nothing behind it.
  it('declares no lint script anywhere', () => {
    for (const relPath of TRACKED_MANIFESTS) {
      const scripts = readManifest(relPath).scripts ?? {};
      expect(Object.keys(scripts), relPath).not.toContain('lint');
    }
  });

  // Doc drift is what turned a stale local script into a believed gate: nothing
  // written down said where the gates live, so the root manifest's mere
  // existence implied they lived there.
  it('is documented in AGENTS.md, named and rooted in ts/', () => {
    const section = AGENTS_MD.match(
      /### Quality gates[\s\S]*?(?=\n### |\n## |$)/,
    );
    expect(
      section,
      'no "### Quality gates" section in AGENTS.md',
    ).not.toBeNull();
    const body = section![0];
    for (const name of GATE_SCRIPTS) {
      expect(body, `gate ${name} not named`).toContain(name);
    }
    expect(body).toContain('ts/');
  });

  it('records the root-manifest shape in the false-green catalogue', () => {
    const doc = readFileSync(
      join(REPO_ROOT, 'docs/knowledge/gates/false-green-detection.md'),
      'utf8',
    );
    expect(doc).toContain('#672');
  });
});
