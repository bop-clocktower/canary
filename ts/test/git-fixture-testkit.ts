/**
 * Build a git fixture once per file, hand each test a cheap private copy
 * (#1243, #1245).
 *
 * Several contract suites need a real repository per test, and used to build
 * it in `beforeEach`: `git init`, a few commits, sometimes a bare origin plus a
 * clone and a push. Every one of those is a synchronous process spawn. On an
 * idle machine the whole hook costs ~150-300 ms; with several agents and
 * vitest workers sharing the cores (load average 4-14) the same hook ran past
 * vitest's 10 s `hookTimeout` and failed whichever tests it happened to land
 * on — a different set each run, never the code under test.
 *
 * The fix is to pay the spawn cost once. `buildGitTemplate` runs the caller's
 * build in `beforeAll`; `copyGitTemplate` gives every test its own copy with a
 * plain recursive file copy and spawns no process at all. A git repository is
 * just files, so the copy is a whole, independent repository: commits,
 * branches, pushes to a bare origin inside the copy, and worktrees all stay in
 * that copy. The isolation each test relied on is unchanged.
 *
 * One caveat callers must handle: anything git recorded as an ABSOLUTE path
 * still names the template (a clone's `remote.origin.url` is the usual one).
 * Re-point it after copying — branch-prune does with one `remote set-url`.
 *
 * Not named `*.test.ts`, so vitest's `test/*.test.ts` glob never collects it.
 * Its own tests live in `git-fixture-testkit.test.ts`.
 */

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Timeout for the one `beforeAll` that calls `buildGitTemplate`.
 *
 * Deliberately generous. The build does the same spawns one old `beforeEach`
 * did, and that work alone was measured past 10 s under load — so the default
 * `hookTimeout` would still fail the file, just once instead of per test. The
 * hook is synchronous, so this does not bound a hang (vitest cannot interrupt
 * a blocked worker; see `vitest.config.ts`); it only stops a slow-but-finished
 * build from being reported as a failure.
 */
export const GIT_TEMPLATE_BUILD_TIMEOUT_MS = 60_000;

/**
 * Create a temp directory, run `build` in it, and return the directory. On a
 * throw the directory is removed and the error rethrown, so a broken build
 * never leaks a half-made repository into the temp dir.
 */
export function buildGitTemplate(
  prefix: string,
  build: (dir: string) => void,
): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    build(dir);
  } catch (err) {
    removeGitFixture(dir);
    throw err;
  }
  return dir;
}

/** A fresh temp directory holding a full copy of `template`. Spawns nothing. */
export function copyGitTemplate(template: string, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cpSync(template, dir, { recursive: true });
  return dir;
}

/** Remove a template or a copy (best-effort; git objects are read-only). */
export function removeGitFixture(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
