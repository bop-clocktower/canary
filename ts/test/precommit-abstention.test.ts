/**
 * Behavioural tests for silent abstention in `.githooks/pre-commit` (#650).
 *
 * The hook guards two gates on the presence of a local binary and, when it is
 * missing, takes the no-op branch without saying so. The skip itself is
 * correct — a fresh clone with no deps should still be able to commit — but
 * **the skip path emits nothing at all**, so the only evidence a gate abstained
 * is a line that isn't there. That is the shape the no-silent-abstention
 * programme (#508) exists to remove, sitting in our own hook.
 *
 * (#650 states this as "byte-identical output". That part is an overstatement —
 * the taken branch does echo a `checking …` line — but the defect underneath it
 * is real, and absence-as-signal is if anything the harder one to notice.)
 *
 * It is not hypothetical: eight parallel agent worktrees symlinked
 * `ts/node_modules` from the primary checkout but had no root `node_modules`,
 * so `node_modules/.bin/markdownlint` never resolved. Every commit in those
 * worktrees ran with markdownlint dark and reported nothing. Seven of the eight
 * never noticed.
 *
 * These tests are behavioural rather than a grep over the hook's source: they
 * run the real hook in a throwaway git repo, once with the binaries absent and
 * once with stubs in place, and assert each gate states its outcome either way.
 * A grep would pass against an `echo` that never executes.
 *
 * Hermetic: the stubs are shell scripts written into the temp repo, so nothing
 * here depends on the host having markdownlint or prettier installed, and the
 * assertions hold identically on a dev laptop and in CI.
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK_SOURCE = join(REPO_ROOT, '.githooks', 'pre-commit');

const createdDirs: string[] = [];

afterAll(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

/** An executable stub that reports it ran, so a real gate is visible in output. */
function writeStub(path: string, banner: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\necho "${banner}"\nexit 0\n`);
  chmodSync(path, 0o755);
}

/**
 * A throwaway repo with the real hook installed and one staged file per gate.
 *
 * `withDeps` decides only whether the two guarded binaries exist; everything
 * else is identical between the two worlds, so any difference in hook output is
 * attributable to the dependency state and nothing else.
 */
function makeRepo(withDeps: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'canary-precommit-'));
  createdDirs.push(dir);

  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, encoding: 'utf-8' });
  };
  git('init', '--quiet');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');

  mkdirSync(join(dir, '.githooks'), { recursive: true });
  cpSync(HOOK_SOURCE, join(dir, '.githooks', 'pre-commit'));
  chmodSync(join(dir, '.githooks', 'pre-commit'), 0o755);

  // One staged file per gate: markdown drives gate 2, `ts/` drives gate 3.
  writeFileSync(join(dir, 'README.md'), '# Title\n');
  mkdirSync(join(dir, 'ts'), { recursive: true });
  writeFileSync(join(dir, 'ts', 'x.ts'), 'export const x = 1;\n');
  writeFileSync(
    join(dir, 'ts', 'package.json'),
    `${JSON.stringify({ name: 'stub', scripts: { 'format:check': 'true' } }, null, 2)}\n`,
  );

  if (withDeps) {
    writeStub(
      join(dir, 'node_modules', '.bin', 'markdownlint'),
      'STUB markdownlint ran',
    );
    writeStub(
      join(dir, 'ts', 'node_modules', '.bin', 'prettier'),
      'STUB prettier ran',
    );
  }

  git('add', '-A');
  return dir;
}

/** Run the hook and return its combined output, whatever its exit status. */
function runHook(dir: string, pathPrefix?: string): string {
  const env =
    pathPrefix === undefined
      ? process.env
      : { ...process.env, PATH: `${pathPrefix}:${process.env['PATH'] ?? ''}` };
  try {
    return execFileSync('bash', ['.githooks/pre-commit'], {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
}

/**
 * A repo with no local markdownlint but an `npx` that resolves one.
 *
 * This is the worktree case the fallback exists for: a tree that symlinks only
 * `ts/node_modules` has no root `node_modules/.bin`, but `npx --no-install`
 * still finds markdownlint. Stubbing `npx` on PATH is what keeps the test
 * hermetic and offline — the real one would hit the network or the user's cache
 * and make the result depend on the machine.
 */
function makeNpxRepo(): string {
  const dir = makeRepo(false);
  const stubBin = join(dir, 'binstub');
  writeStub(join(stubBin, 'npx'), 'STUB npx markdownlint ran');
  return dir;
}

const withoutDeps = runHook(makeRepo(false));
const withDeps = runHook(makeRepo(true));
const npxRepo = makeNpxRepo();
const viaNpx = runHook(npxRepo, join(npxRepo, 'binstub'));

/** Status lines the hook prints about one named gate, in one run. */
function statusLines(output: string, gate: string): string[] {
  return output
    .split('\n')
    .filter(
      (l) => l.includes('[pre-commit]') && l.toLowerCase().includes(gate),
    );
}

describe('pre-commit abstentions are legible (#650)', () => {
  /**
   * The invariant, stated as "every gate speaks exactly once" rather than as
   * #650's "the two outputs are byte-identical". The issue overstates that
   * detail — the taken branch does echo a `checking …` line, so the two runs
   * already differ. What is true, and what actually bit, is weaker and still
   * bad: on the skip path the gate says *nothing*, so its absence is the only
   * signal, and a missing line among a dozen others is not something anyone
   * notices. Asserting a positive statement on both branches is the property
   * that survives someone later adding output to either one.
   */
  it.each([['markdownlint'], ['prettier']])(
    'the %s gate reports its outcome on both branches',
    (gate) => {
      expect(statusLines(withDeps, gate)).toHaveLength(1);
      expect(statusLines(withoutDeps, gate)).toHaveLength(1);
    },
  );

  it('runs both gates for real when the binaries are present', () => {
    expect(withDeps).toContain('STUB markdownlint ran');
    expect(withDeps).toMatch(/prettier: checking/);
  });

  it('reports markdownlint as skipped when its binary is absent', () => {
    expect(withoutDeps).toMatch(/markdownlint[^\n]*SKIPPED/i);
  });

  /**
   * The middle branch, and the load-bearing one: it is what turns the common
   * worktree case from an announced skip back into a gate that actually runs.
   * Without this, the only covered paths are "local binary" and "nothing", and
   * a regression in the npx fallback would degrade silently to a skip — the
   * exact failure #650 is about, one level down.
   */
  it('runs markdownlint via npx when only the local binary is absent', () => {
    expect(viaNpx).toContain('STUB npx markdownlint ran');
    expect(viaNpx).toMatch(/markdownlint[^\n]*resolved via npx/i);
  });

  it('does not report a skip when the npx fallback resolved', () => {
    expect(statusLines(viaNpx, 'markdownlint')).toHaveLength(1);
    expect(viaNpx).not.toMatch(/markdownlint[^\n]*SKIPPED/i);
  });

  it('reports prettier as skipped when its binary is absent', () => {
    expect(withoutDeps).toMatch(/prettier[^\n]*SKIPPED/i);
  });

  it('names the remedy on every skip line', () => {
    const skips = withoutDeps.split('\n').filter((l) => /SKIPPED/i.test(l));
    expect(skips.length).toBeGreaterThanOrEqual(2);
    // A skip the committer cannot act on is only marginally better than silence.
    for (const line of skips) expect(line).toMatch(/npm (ci|install)/);
  });

  it('does not claim a gate ran when it did not', () => {
    expect(withoutDeps).not.toContain('STUB markdownlint ran');
  });
});

describe('node_modules is ignored even when it is a symlink (#650)', () => {
  /**
   * `node_modules/` with a trailing slash matches a directory but not a symlink
   * of the same name. The agent worktrees that surfaced #650 symlinked
   * `ts/node_modules`, so it showed as untracked `??` — a live `git add -A`
   * footgun in exactly the setup that hid the linter.
   */
  it.each([
    ['.gitignore', 'node_modules'],
    ['ts/.gitignore', 'ts/node_modules'],
  ])('%s ignores a symlinked %s', (_ignoreFile, target) => {
    const dir = mkdtempSync(join(tmpdir(), 'canary-ignore-'));
    createdDirs.push(dir);
    execFileSync('git', ['init', '--quiet'], { cwd: dir });

    // Reproduce the repo's ignore rules against a symlink, not a directory.
    for (const f of ['.gitignore', 'ts/.gitignore']) {
      mkdirSync(join(dir, dirname(f)), { recursive: true });
      cpSync(join(REPO_ROOT, f), join(dir, f));
    }
    mkdirSync(join(dir, dirname(target)), { recursive: true });
    execFileSync('ln', ['-s', '/tmp', join(dir, target)]);

    const status = execFileSync(
      'git',
      ['status', '--porcelain', '--untracked-files=all'],
      {
        cwd: dir,
        encoding: 'utf-8',
      },
    );
    expect(status).not.toMatch(/node_modules/);
  });
});
