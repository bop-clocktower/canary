/**
 * #369 — `pr-check` must not silently no-op in CI.
 *
 * When `--diff` is omitted the legacy behavior ran a bare `git diff`
 * (working-tree vs. index), which is EMPTY on a clean `actions/checkout` — so
 * the gate reported success without ever scoping a single path. These tests pin
 * the two halves of the fix:
 *
 *   1. In a CI/PR context, an omitted `--diff` resolves the PR diff from the
 *      base ref (`origin/$GITHUB_BASE_REF`, `$GITHUB_BASE_REF`, or the event
 *      payload's `pull_request.base.sha`) via `git diff <base>...HEAD`.
 *   2. When no base is resolvable AND the fallback diff is empty, the run warns
 *      LOUDLY (`::warning::` + stderr + step summary) instead of reporting a
 *      silent green no-op.
 *
 * Local (non-CI) behavior is unchanged: bare `git diff`, then `git diff
 * --staged`. Network-free; `git` is injected through {@link GuardianDeps}.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GitResult, GuardianDeps, readPrDiff } from '../src/guardian/cli.js';
import { invokeGuardian, mkTmp, rmTmp } from './guardian-cli-testkit.js';

const DIFF_NEW_UNIT = `diff --git a/pkg/widget.py b/pkg/widget.py
index 1111111..2222222 100644
--- a/pkg/widget.py
+++ b/pkg/widget.py
@@ -0,0 +1,3 @@
+def widget():
+    return 42
+
`;

/** A recorded `git` invocation: the argv it was called with. */
type GitCall = string[];

interface FakeGit {
  runGit: (args: string[], cwd?: string) => GitResult | null;
  calls: GitCall[];
}

/**
 * Build a `runGit` seam over a `{ 'argv joined by space': GitResult }` table.
 *
 * Any argv not in the table resolves to `{ code: 1, stdout: '' }` — the shape
 * git uses for "ref does not exist" / "not a repo", so an unlisted `rev-parse
 * --verify` correctly reads as unresolvable.
 */
function fakeGit(table: Record<string, GitResult>): FakeGit {
  const calls: GitCall[] = [];
  return {
    calls,
    runGit: (args) => {
      calls.push(args);
      return table[args.join(' ')] ?? { code: 1, stdout: '' };
    },
  };
}

const ok = (stdout = ''): GitResult => ({ code: 0, stdout });

/** Minimal deps stub for the pure {@link readPrDiff} helper. */
function depsFor(
  git: FakeGit,
  env: Record<string, string | undefined>,
  stdin = '',
): GuardianDeps {
  return {
    out: () => {},
    err: () => {},
    readStdin: () => stdin,
    env: env as NodeJS.ProcessEnv,
    cwd: () => '.',
    runGit: git.runGit,
  } as unknown as GuardianDeps;
}

// --- readPrDiff (pure resolution) --------------------------------------------

describe('readPrDiff base-ref resolution (#369)', () => {
  it('prefers origin/<GITHUB_BASE_REF> in a GitHub Actions PR context', () => {
    const git = fakeGit({
      'rev-parse --verify --quiet origin/main^{commit}': ok('abc123\n'),
      'diff origin/main...HEAD': ok(DIFF_NEW_UNIT),
    });
    const res = readPrDiff(
      null,
      depsFor(git, { GITHUB_ACTIONS: 'true', GITHUB_BASE_REF: 'main' }),
    );

    expect(res.origin).toBe('ci-base');
    expect(res.base).toBe('origin/main');
    expect(res.text).toBe(DIFF_NEW_UNIT);
    // The broken bare `git diff` must never be reached in this path.
    expect(git.calls).not.toContainEqual(['diff']);
  });

  it('falls back to the bare base ref when origin/<ref> is absent', () => {
    const git = fakeGit({
      'rev-parse --verify --quiet main^{commit}': ok('abc123\n'),
      'diff main...HEAD': ok(DIFF_NEW_UNIT),
    });
    const res = readPrDiff(
      null,
      depsFor(git, { CI: 'true', GITHUB_BASE_REF: 'main' }),
    );

    expect(res.origin).toBe('ci-base');
    expect(res.base).toBe('main');
    expect(res.text).toBe(DIFF_NEW_UNIT);
  });

  it('falls back to the event payload pull_request.base.sha', () => {
    const tmp = mkTmp();
    try {
      const eventPath = join(tmp, 'event.json');
      writeFileSync(
        eventPath,
        JSON.stringify({ pull_request: { base: { sha: 'basesha1' } } }),
        'utf-8',
      );
      const git = fakeGit({
        'rev-parse --verify --quiet basesha1^{commit}': ok('basesha1\n'),
        'diff basesha1...HEAD': ok(DIFF_NEW_UNIT),
      });
      const res = readPrDiff(
        null,
        depsFor(git, { GITHUB_ACTIONS: 'true', GITHUB_EVENT_PATH: eventPath }),
      );

      expect(res.origin).toBe('ci-base');
      expect(res.base).toBe('basesha1');
      expect(res.text).toBe(DIFF_NEW_UNIT);
    } finally {
      rmTmp(tmp);
    }
  });

  it('keeps working-tree behavior when not in CI', () => {
    const git = fakeGit({ diff: ok(DIFF_NEW_UNIT) });
    const res = readPrDiff(null, depsFor(git, {}));

    expect(res.origin).toBe('worktree');
    expect(res.base).toBeNull();
    expect(res.text).toBe(DIFF_NEW_UNIT);
  });

  it('falls back to --staged when the worktree is clean (unchanged)', () => {
    const git = fakeGit({ diff: ok(''), 'diff --staged': ok(DIFF_NEW_UNIT) });
    const res = readPrDiff(null, depsFor(git, {}));

    expect(res.origin).toBe('worktree');
    expect(res.text).toBe(DIFF_NEW_UNIT);
  });

  it('falls back to the worktree when the CI base ref is unresolvable', () => {
    // `fetch-depth: 1` — the base commit is simply not in the clone.
    const git = fakeGit({ diff: ok(''), 'diff --staged': ok('') });
    const res = readPrDiff(
      null,
      depsFor(git, { GITHUB_ACTIONS: 'true', GITHUB_BASE_REF: 'main' }),
    );

    expect(res.origin).toBe('worktree');
    expect(res.text).toBe('');
  });

  it('never shells git for an explicit --diff source', () => {
    const git = fakeGit({});
    const res = readPrDiff('-', depsFor(git, { GITHUB_ACTIONS: 'true' }, 'X'));

    expect(res.origin).toBe('stdin');
    expect(res.text).toBe('X');
    expect(git.calls).toEqual([]);
  });
});

// --- CLI wiring ---------------------------------------------------------------

describe('pr-check CI empty-diff warning (#369)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkTmp();
  });
  afterEach(() => {
    rmTmp(tmp);
  });

  it('scopes the resolved base diff instead of no-opping', async () => {
    const git = fakeGit({
      'rev-parse --verify --quiet origin/main^{commit}': ok('abc123\n'),
      'diff origin/main...HEAD': ok(DIFF_NEW_UNIT),
    });
    const res = await invokeGuardian(['pr-check', '--format', 'json'], {
      cwd: tmp,
      env: { GITHUB_ACTIONS: 'true', GITHUB_BASE_REF: 'main' },
      deps: { runGit: git.runGit },
    });

    expect(res.code).toBe(0);
    expect(res.stdout).not.toContain('nothing to verify');
    const data = JSON.parse(res.stdout);
    expect(data.findings.map((f: { path: string }) => f.path)).toContain(
      'pkg/widget.py',
    );
  });

  it('warns loudly on an empty auto-resolved diff in CI', async () => {
    const git = fakeGit({ diff: ok(''), 'diff --staged': ok('') });
    const summary = join(tmp, 'summary.md');
    const res = await invokeGuardian(['pr-check', '--format', 'text'], {
      cwd: tmp,
      env: { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary },
      deps: { runGit: git.runGit },
    });

    // Non-blocking (an existing green build must not flip red) but IMPOSSIBLE
    // to mistake for a working gate.
    expect(res.code).toBe(3);
    expect(res.stdout.toLowerCase()).toContain('abstained');
    expect(res.stdout).toContain('::warning::');
    expect(res.stderr).toContain('--diff');
    expect(res.stderr.toLowerCase()).toContain('0 changed paths');
  });

  it('abstains loudly on an empty diff outside CI (#508)', async () => {
    const git = fakeGit({ diff: ok(''), 'diff --staged': ok('') });
    const res = await invokeGuardian(['pr-check', '--format', 'text'], {
      cwd: tmp,
      deps: { runGit: git.runGit },
    });

    expect(res.code).toBe(3);
    expect(res.stdout.toLowerCase()).toContain('abstained');
    expect(res.stdout).not.toContain('::warning::');
    expect(res.stderr).toBe('');
  });

  it('does not warn when an explicit --diff is empty', async () => {
    const res = await invokeGuardian(['pr-check', '--diff', '-'], {
      input: '',
      cwd: tmp,
      env: { GITHUB_ACTIONS: 'true' },
    });

    expect(res.code).toBe(3);
    expect(res.stdout.toLowerCase()).toContain('abstained');
    expect(res.stdout).not.toContain('::warning::');
  });
});
