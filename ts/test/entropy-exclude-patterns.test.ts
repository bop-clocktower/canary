/**
 * Structural tests for `entropy.excludePatterns` in `harness.config.json`
 * (#677).
 *
 * Same failure class as the sibling `entropy-entrypoints.test.ts`, at the other
 * end of the same scan: **an exclude list that misses a whole file family still
 * reports as an exclude list.** Where the entry-point bug emptied the root set,
 * this one inflates the denominator.
 *
 * The instance: the repo declared no `entropy.excludePatterns` at all, so the
 * analyzer applied its schema default — `[...skipDirGlobs(), '**\/*.test.ts']`.
 * That default is TypeScript-shaped. The npm package's tests are `.js`, run by
 * `node --test`, so all 32 of them were scanned as ordinary source files and
 * every one came back unreferenced *by design* — a `node --test` file has no
 * importer. Those pure analyzer artifacts were absorbed into the triaged
 * baseline of 340, which is exactly the headroom that hides a real new finding,
 * and it made adding a `.js` test cost ratchet budget (#674 paid it twice).
 *
 * Four invariants, none of which requires running `harness`:
 *
 * 1. The list is declared in-repo rather than inherited. The upstream default
 *    is the thing that was wrong; a config that says nothing cannot be reviewed
 *    and changes silently on a CLI bump.
 *
 * 2. Every test-file *shape that actually exists in this repo* is excluded.
 *    Derived from `git ls-files`, never from a hardcoded list — a fixed list
 *    would pass unchanged on the day someone adds `.spec.js`, which is the
 *    zero-denominator shape this suite exists to refuse.
 *
 * 3. Materializing the list does not narrow it. Declaring the key replaces the
 *    schema default wholesale (zod `.default()`, not a merge), so the
 *    build-output directories the analyzer would otherwise skip have to be
 *    carried explicitly or the scan silently widens to `dist/` and
 *    `node_modules/`.
 *
 * 4. No entry point is a test file. Excluded files are never in the snapshot,
 *    so declaring one as a reachability root is dead config — and the two
 *    `uninstall-*.test.js` entries #674 added are precisely the workaround this
 *    fix retires.
 *
 * Offline: reads `harness.config.json` and asks git for its index.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** `foo.test.ts`, `foo.spec.js`, ... — the suffix families the analyzer sees. */
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;

/**
 * The directories `findFiles` hard-ignores upstream. Kept to those four rather
 * than mirroring the ~40-entry `DEFAULT_SKIP_DIRS`: this is a tripwire against
 * an accidentally narrowed list, not a replica that would rot on the next
 * upstream edit.
 */
const REQUIRED_DIR_GLOBS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
];

interface HarnessConfig {
  entropy?: { entryPoints?: string[]; excludePatterns?: string[] };
  performance?: { entryPoints?: string[] };
}

const CONFIG: HarnessConfig = JSON.parse(
  readFileSync(join(REPO_ROOT, 'harness.config.json'), 'utf8'),
) as HarnessConfig;

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean);
}

/** `npm/scripts/__tests__/x.test.js` -> `**\/*.test.js`. */
function globFor(path: string): string {
  const [, kind, ext] = TEST_FILE_RE.exec(path) as RegExpExecArray;
  return `**/*.${kind}.${ext}`;
}

const EXCLUDES = CONFIG.entropy?.excludePatterns ?? [];

describe('entropy.excludePatterns', () => {
  it('is declared in-repo rather than inherited from the CLI default', () => {
    expect(Array.isArray(CONFIG.entropy?.excludePatterns)).toBe(true);
    expect(EXCLUDES.length).toBeGreaterThan(0);
  });

  it('excludes every test-file shape present in the repo', () => {
    const present = trackedFiles().filter((p) => TEST_FILE_RE.test(p));
    // Guard the guard: no test files found would satisfy the rule vacuously.
    expect(present.length).toBeGreaterThan(0);

    const required = [...new Set(present.map(globFor))].sort();
    const missing = required.filter((g) => !EXCLUDES.includes(g));
    expect(missing).toEqual([]);
  });

  it('still carries the build-output directories the analyzer skips', () => {
    const missing = REQUIRED_DIR_GLOBS.filter((g) => !EXCLUDES.includes(g));
    expect(missing).toEqual([]);
  });
});

/**
 * Repo-rooted exclusions (#700) — the anchored patterns, as opposed to the
 * `**\/`-prefixed file-kind rules above that deliberately match tracked files
 * everywhere.
 *
 * Why these exist: the entropy ratchet is a blocking gate that could not be
 * run in a normal working directory. On `main` @ `97bb15f` CI measured 282 and
 * a fresh worktree measured 282, while the shared working directory measured
 * 346 — +64, every one of them in a path that exists only on a developer
 * machine. The analyzer has NO `.gitignore` awareness at all; its walk sets
 * `dot: true` deliberately, and what keeps local junk out is a hardcoded
 * `DEFAULT_SKIP_DIRS` list of directory *basenames* plus whatever this config
 * declares. `.claude/worktrees/` is quiet because `.claude` is on that list;
 * `tests/generated/` was noisy because it is not.
 *
 * Upstream limit, measured against CLI 11.1.1 and NOT worked around here: a
 * path under a dot-directory that upstream does not already skip cannot be
 * excluded by ANY `excludePatterns` entry — eight forms were tried, down to
 * the exact literal relative path, and all left the count unchanged. That is
 * why `.kiro/**` and `.remember/**` are deliberately absent from the config: a
 * pattern that matches nothing is the vacuous-rule shape this file exists to
 * refuse. Measure the ratchet in a fresh worktree until upstream is fixed.
 */
const repoRootedExcludes = EXCLUDES.filter((p) => !p.startsWith('**/'));

/**
 * True when the repo's *committed* ignore rules cover `path`. `--no-index` so
 * the answer does not depend on the path existing on this machine.
 */
function isGitIgnored(path: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '--no-index', '-q', '--', path], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

describe('entropy.excludePatterns repo-rooted entries', () => {
  // Guard the guard: an empty list satisfies every "for each" rule below
  // without checking anything.
  it('declares the local-only artifact roots it is meant to cover', () => {
    expect(repoRootedExcludes).toContain('tests/generated/**');
  });

  it('writes each one as an unambiguous directory glob', () => {
    const malformed = repoRootedExcludes.filter((p) => !p.endsWith('/**'));
    expect(malformed).toEqual([]);
  });

  // The dangerous direction. An anchored exclusion that CI can also see would
  // silently shrink the denominator and let the ratchet pass over real
  // findings. `.gitignore` has to say so at the repo level: a `.gitignore`
  // written *inside* an untracked artifact directory by the tool that owns it
  // does not exist in `actions/checkout`, so it proves nothing about CI.
  it('keeps every one invisible to CI (git-ignored at the repo level)', () => {
    const visibleToCi = repoRootedExcludes
      .map((p) => p.slice(0, -'/**'.length))
      .filter((dir) => !isGitIgnored(`${dir}/probe`));
    expect(visibleToCi).toEqual([]);
  });

  it('excludes no git-tracked file', () => {
    const prefixes = repoRootedExcludes.map((p) => p.slice(0, -'**'.length));
    const hidden = trackedFiles().filter((f) =>
      prefixes.some((prefix) => f.startsWith(prefix)),
    );
    expect(hidden).toEqual([]);
  });
});

describe('entry points', () => {
  it('never declares a test file as a reachability root', () => {
    for (const key of ['entropy', 'performance'] as const) {
      const entries = CONFIG[key]?.entryPoints ?? [];
      expect(
        entries.filter((p) => TEST_FILE_RE.test(p)),
        `${key}.entryPoints declares an excluded test file`,
      ).toEqual([]);
    }
  });
});
