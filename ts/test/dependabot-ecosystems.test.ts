/**
 * Denominator test for `.github/dependabot.yml` (#752).
 *
 * Two failures at once, and only the loud one was visible:
 *
 * 1. A `pip` entry survived the v6.0.0 retirement of the Python reference. It
 *    pointed at a directory with no Python manifest and failed every weekly run
 *    from 2026-08-02 onward — `dependency_file_not_found`, red on `main` for
 *    three weeks.
 *
 * 2. There was no `npm` version-update entry at all. The `npm_and_yarn` runs in
 *    the history are *security* updates raised off the advisory database, which
 *    need no config entry, so the history read as covered while every scheduled
 *    version update for `ts/`, `npm/` and `agents/skills/` was missing.
 *
 * The red job about a language the repo removed became the wallpaper that hid a
 * missing ecosystem. Both halves are the same false-green shape, so both get an
 * invariant here:
 *
 * 1. **No entry over an empty denominator.** Every declared ecosystem's
 *    directory must actually contain a manifest that ecosystem reads. This is
 *    what the `pip` entry violated.
 *
 * 2. **No manifest without an entry.** Every git-tracked npm lockfile must have
 *    a matching `npm` entry. A lockfile is the tell that a directory has
 *    resolved dependencies worth updating — `.harness/hooks/package.json`
 *    declares none and has none, so it is correctly out of scope. This is what
 *    the missing `npm` entries violated.
 *
 * Offline: parses the config with js-yaml and asks git for its index.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG_PATH = '.github/dependabot.yml';

interface UpdateEntry {
  'package-ecosystem'?: string;
  directory?: string;
  directories?: string[];
}

interface DependabotConfig {
  version?: number;
  updates?: UpdateEntry[];
}

/**
 * The manifest filenames each ecosystem looks for. Only the ecosystems this
 * repo declares (or should) are listed — a tripwire, not a replica of
 * Dependabot's full matrix, which would rot the first time upstream adds one.
 * An ecosystem outside this map fails invariant 1 loudly rather than passing
 * silently, which is the whole point.
 */
const MANIFESTS: Record<string, string[]> = {
  pip: ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile'],
  npm: ['package.json'],
  'github-actions': ['.github/workflows'],
};

function config(): DependabotConfig {
  return loadYaml(
    readFileSync(join(REPO_ROOT, CONFIG_PATH), 'utf8'),
  ) as DependabotConfig;
}

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split('\n').filter(Boolean);
}

/** Normalise a dependabot `directory` (`/`, `/ts`) to a repo-relative prefix. */
function asPrefix(directory: string): string {
  const trimmed = directory.replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed === '' ? '' : `${trimmed}/`;
}

/** Every (ecosystem, directory) pair the config declares, flattened. */
function declaredPairs(): Array<{ ecosystem: string; directory: string }> {
  return (config().updates ?? []).flatMap((entry) => {
    const ecosystem = entry['package-ecosystem'] ?? '(missing)';
    const dirs =
      entry.directories ?? (entry.directory ? [entry.directory] : []);
    return dirs.map((directory) => ({ ecosystem, directory }));
  });
}

const TRACKED = trackedFiles();

/**
 * Directories with a tracked npm lockfile. Fixture manifests under
 * `ts/test/fixtures/` have no lockfile and are excluded by construction.
 */
function npmProjectDirs(): string[] {
  return TRACKED.filter((f) => f.endsWith('package-lock.json')).map((f) =>
    f.slice(0, -'package-lock.json'.length),
  );
}

describe('dependabot ecosystems match the repo (#752)', () => {
  it('parses as a v2 config with at least one update entry', () => {
    const parsed = config();
    expect(parsed.version).toBe(2);
    expect(declaredPairs().length).toBeGreaterThan(0);
  });

  it('enumerates a non-empty set of npm project directories', () => {
    // Guards this test's own denominator: no lockfiles found would make the
    // coverage assertion below vacuously true.
    expect(npmProjectDirs().length).toBeGreaterThan(0);
  });

  it('declares no ecosystem over a directory with no such manifest', () => {
    const empty = declaredPairs().filter(({ ecosystem, directory }) => {
      const names = MANIFESTS[ecosystem];
      if (!names) return true; // unknown ecosystem: fail loudly, not silently
      const prefix = asPrefix(directory);
      return !names.some((name) =>
        TRACKED.some(
          (f) => f === `${prefix}${name}` || f.startsWith(`${prefix}${name}/`),
        ),
      );
    });
    expect(empty).toEqual([]);
  });

  it('covers every npm project directory with an npm entry', () => {
    const covered = new Set(
      declaredPairs()
        .filter((p) => p.ecosystem === 'npm')
        .map((p) => asPrefix(p.directory)),
    );
    const uncovered = npmProjectDirs().filter((d) => !covered.has(d));
    expect(uncovered).toEqual([]);
  });

  it('schedules every entry', () => {
    const unscheduled = (config().updates ?? []).filter(
      (e) => !('schedule' in e),
    );
    expect(unscheduled).toEqual([]);
  });
});
