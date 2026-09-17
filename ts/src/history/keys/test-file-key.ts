/**
 * The history join key `record` writes (#1021, ADR 0029): a test file's
 * repo-relative path. The commit half moved to `replay-context.ts` (#461),
 * which also records where the commit came from.
 *
 * `record` stores `test_file` relative to the git top-level with `/`
 * separators, so a stored row equals a `git diff --name-only` path. Before
 * this, the three readers wrote three bases: vitest an absolute path from the
 * machine that ran, Playwright a path relative to its `testDir`, JUnit
 * whatever `file` attribute the producer set (often none). No diff path joined
 * to any of them.
 *
 * A path that cannot be made repo-relative (empty, outside the repo, relative
 * to an unknown base, or no repo at all) is KEPT as written and COUNTED. It is
 * never dropped, because the row still carries a result, and never guessed,
 * because a wrong key joins silently where a missing one is visible.
 */

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { BuiltRun, ReportShape } from '../run-recorder.js';
import type { TestResultInput } from '../schema.js';

export interface PathBase {
  /** `git rev-parse --show-toplevel`, or null outside a repository. */
  topLevel: string | null;
  /** What a relative report path is relative to; absent means unknown. */
  baseDir?: string | undefined;
}

/** Resolve symlinks (macOS `/var` vs `/private/var`) when the path exists. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The repo-relative POSIX key for `file`, or null when there is none. */
export function toRepoRelative(file: string, base: PathBase): string | null {
  const absolute = absoluteOf(file, base.baseDir);
  if (absolute === null || base.topLevel === null) return null;
  const rel = relative(real(base.topLevel), absolute);
  return isInside(rel) ? rel.split(sep).join('/') : null;
}

/** The real absolute path of `file`, or null when its base is unknown. */
function absoluteOf(file: string, baseDir: string | undefined): string | null {
  if (!file) return null;
  if (isAbsolute(file)) return real(file);
  return baseDir === undefined ? null : real(resolve(baseDir, file));
}

/** A non-empty relative path that does not climb out of its root. */
function isInside(rel: string): boolean {
  const escapes = rel === '..' || rel.startsWith(`..${sep}`);
  return rel !== '' && !escapes && !isAbsolute(rel);
}

/** Rewrite every row's `test_file` to its key; count the rows left as-is. */
export function normalizeTestFiles(
  results: TestResultInput[],
  base: PathBase,
): { results: TestResultInput[]; unjoinable: number } {
  let unjoinable = 0;
  const out = results.map((r) => {
    const key = toRepoRelative(r.test_file ?? '', base);
    if (key === null) {
      unjoinable += 1;
      return r;
    }
    return { ...r, test_file: key };
  });
  return { results: out, unjoinable };
}

interface PwConfig {
  config?: { rootDir?: unknown; projects?: { testDir?: unknown }[] };
}

/**
 * The directory a Playwright JSON report's file paths are relative to: the
 * config `rootDir` (the resolved `testDir`), else the first project's
 * `testDir`. Undefined when the report carries neither, so those paths count
 * as unjoinable instead of being resolved against a guessed base.
 */
export function playwrightBaseDir(parsed: unknown): string | undefined {
  const config = (parsed as PwConfig).config;
  const candidates = [config?.rootDir, config?.projects?.[0]?.testDir];
  return candidates.find((c): c is string => typeof c === 'string' && c !== '');
}

/**
 * Run git in the working directory: trimmed stdout, or null when git is
 * missing, the directory is not a repository, or the ref does not resolve.
 */
export function runGit(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** The two repository facts keying needs; `HistoryDeps` satisfies it. */
export interface RepoProbe {
  git(args: string[]): string | null;
  cwd(): string;
}

/** A converted run whose `test_file`s are repo-relative keys. */
export interface KeyedRun extends BuiltRun {
  /** Rows whose `test_file` could not be made repo-relative (kept as-is). */
  unjoinable: number;
}

/**
 * Key a converted run's rows. Playwright paths are relative to the report's
 * testDir; vitest and JUnit paths are absolute or relative to where the
 * command runs.
 */
export function keyTestFiles(
  built: BuiltRun,
  shape: ReportShape,
  parsed: unknown,
  probe: RepoProbe,
): KeyedRun {
  const topLevel = probe.git(['rev-parse', '--show-toplevel']);
  const baseDir =
    shape === 'playwright' ? playwrightBaseDir(parsed) : probe.cwd();
  const keyed = normalizeTestFiles(built.results, { topLevel, baseDir });
  return { run: built.run, ...keyed };
}
