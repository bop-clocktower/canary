/**
 * canary-dev-pipeline (#666) -- what the pipeline looks at. With no arguments
 * that is the working diff: tracked changes against the merge base with the
 * default branch, plus untracked files. Explicit paths replace it. Every git
 * call is argv, never a shell string. Fixtures are synthetic repositories in
 * temp directories.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_TARGETS,
  classify,
  resolveTarget,
} from '../claude-code/canary-dev-pipeline/scripts/target.mjs';

const tmps: string[] = [];
function tmp(prefix = 'canary-devpipe-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmps.push(dir);
  return dir;
}

afterEach(() => {
  while (tmps.length) {
    fs.rmSync(tmps.pop()!, { recursive: true, force: true });
  }
});

function git(dir: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-C',
      dir,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function write(dir: string, rel: string, text = 'x\n'): void {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A repo on `main` with one commit, then a feature branch checked out. */
function repoWithBranch(dir = tmp()): string {
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, 'src/base.ts', 'export const base = 1;\n');
  write(dir, 'README.md', '# r\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feature');
  return dir;
}

const paths = (t: { files: { path: string }[] }) => t.files.map((f) => f.path);

describe('classify', () => {
  it('splits test, source and other files', () => {
    expect(classify('src/cart.ts')).toBe('source');
    expect(classify('lib/cart.py')).toBe('source');
    expect(classify('app/Cart.php')).toBe('source');
    expect(classify('tests/cart.test.ts')).toBe('test');
    expect(classify('src/cart.spec.js')).toBe('test');
    expect(classify('test_cart.py')).toBe('test');
    expect(classify('types/cart.d.ts')).toBe('other');
    expect(classify('docs/cart.md')).toBe('other');
    expect(classify('package.json')).toBe('other');
  });
});

describe('resolveTarget -- the working diff (default)', () => {
  it('takes committed, staged, unstaged and untracked changes against the merge base', () => {
    const dir = repoWithBranch();
    write(dir, 'src/committed.ts');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'c');
    write(dir, 'src/staged.ts');
    git(dir, 'add', 'src/staged.ts');
    write(dir, 'src/base.ts', 'export const base = 2;\n');
    write(dir, 'tests/new.test.ts');
    const t = resolveTarget({ repo: dir, paths: [] });
    expect(t.mode).toBe('diff');
    expect(t.abstain).toBeNull();
    expect(t.baseRef).toBe('main');
    expect(t.base).toMatch(/^[0-9a-f]{40}$/);
    expect(paths(t)).toEqual([
      'src/base.ts',
      'src/committed.ts',
      'src/staged.ts',
      'tests/new.test.ts',
    ]);
    expect(t.files.map((f: { kind: string }) => f.kind)).toEqual([
      'source',
      'source',
      'source',
      'test',
    ]);
  });

  it('abstains on an empty working diff rather than reporting all clear', () => {
    const dir = repoWithBranch();
    const t = resolveTarget({ repo: dir, paths: [] });
    expect(t.files).toEqual([]);
    expect(t.abstain).toMatch(/working diff is empty/);
  });

  it('abstains outside a git repository', () => {
    const t = resolveTarget({ repo: tmp(), paths: [] });
    expect(t.abstain).toMatch(/not a git repository/);
  });

  it('counts deleted files without listing them', () => {
    const dir = repoWithBranch();
    fs.rmSync(path.join(dir, 'src/base.ts'));
    write(dir, 'src/kept.ts');
    const t = resolveTarget({ repo: dir, paths: [] });
    expect(paths(t)).toEqual(['src/kept.ts']);
    expect(t.deleted).toBe(1);
  });

  it('prefers the branch origin/HEAD points at', () => {
    const dir = repoWithBranch();
    git(dir, 'update-ref', 'refs/remotes/origin/trunk', 'main');
    git(
      dir,
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/trunk',
    );
    write(dir, 'src/x.ts');
    const t = resolveTarget({ repo: dir, paths: [] });
    expect(t.baseRef).toBe('origin/trunk');
  });

  it('falls back to uncommitted changes, and says so, when no default branch resolves', () => {
    const dir = tmp();
    git(dir, 'init', '-q', '-b', 'work');
    write(dir, 'src/a.ts');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'a');
    write(dir, 'src/a.ts', 'changed\n');
    const t = resolveTarget({ repo: dir, paths: [] });
    expect(t.baseRef).toBe('HEAD');
    expect(paths(t)).toEqual(['src/a.ts']);
    expect(t.notes.join(' ')).toMatch(/no default branch/);
  });

  it('reads every file in a repository with no commit yet', () => {
    const dir = tmp();
    git(dir, 'init', '-q', '-b', 'main');
    write(dir, 'src/a.ts');
    const t = resolveTarget({ repo: dir, paths: [] });
    expect(t.base).toBeNull();
    expect(paths(t)).toEqual(['src/a.ts']);
  });

  it('keeps a file name holding a newline as one entry', () => {
    const dir = repoWithBranch();
    write(dir, 'src/a\nb.ts');
    const t = resolveTarget({ repo: dir, paths: [] });
    expect(paths(t)).toEqual(['src/a\nb.ts']);
  });

  it('uses a repository path with shell metacharacters literally (argv, no shell)', () => {
    const parent = tmp();
    const dir = path.join(parent, 'r $(touch pwned) ;`touch pwned2`');
    fs.mkdirSync(dir);
    repoWithBranch(dir);
    write(dir, 'src/x.ts');
    const t = resolveTarget({ repo: dir, paths: [] });
    expect(paths(t)).toEqual(['src/x.ts']);
    expect(fs.existsSync(path.join(parent, 'pwned'))).toBe(false);
    expect(fs.existsSync('pwned')).toBe(false);
    expect(fs.existsSync('pwned2')).toBe(false);
  });

  it('lets --repo decide even when a hook exported GIT_DIR', () => {
    const dir = repoWithBranch();
    write(dir, 'src/x.ts');
    const other = tmp();
    git(other, 'init', '-q', '-b', 'main');
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(other, '.git');
    try {
      expect(paths(resolveTarget({ repo: dir, paths: [] }))).toEqual([
        'src/x.ts',
      ]);
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
  });

  it(`clamps the target at ${MAX_TARGETS} files and counts the rest`, () => {
    const dir = repoWithBranch();
    for (let i = 0; i < MAX_TARGETS + 7; i += 1) {
      write(dir, `src/f${String(i).padStart(3, '0')}.ts`);
    }
    const t = resolveTarget({ repo: dir, paths: [] });
    expect(t.files).toHaveLength(MAX_TARGETS);
    expect(t.clamped).toBe(7);
  });
});

describe('resolveTarget -- explicit paths override the diff', () => {
  it('reads only the named file, not the working diff', () => {
    const dir = repoWithBranch();
    write(dir, 'src/changed.ts');
    const t = resolveTarget({
      repo: dir,
      paths: ['src/base.ts'],
      cwd: dir,
    });
    expect(t.mode).toBe('paths');
    expect(paths(t)).toEqual(['src/base.ts']);
  });

  it('walks a directory, skipping heavy directories', () => {
    const dir = repoWithBranch();
    write(dir, 'src/sub/a.ts');
    write(dir, 'src/node_modules/dep/index.js');
    const t = resolveTarget({ repo: dir, paths: ['src'], cwd: dir });
    expect(paths(t)).toEqual(['src/base.ts', 'src/sub/a.ts']);
  });

  it('notes a missing path and a path outside the repository', () => {
    const dir = repoWithBranch();
    const outside = path.join(tmp(), 'o.ts');
    fs.writeFileSync(outside, 'x');
    const t = resolveTarget({
      repo: dir,
      paths: ['nope.ts', outside, 'src/base.ts'],
      cwd: dir,
    });
    expect(paths(t)).toEqual(['src/base.ts']);
    expect(t.notes.join('\n')).toMatch(/path not found: nope\.ts/);
    expect(t.notes.join('\n')).toMatch(/outside the repository/);
  });

  it('abstains when the paths select nothing', () => {
    const dir = repoWithBranch();
    const t = resolveTarget({ repo: dir, paths: ['nope'], cwd: dir });
    expect(t.abstain).toMatch(/select no file/);
  });

  it('works outside a git repository, rooted at --repo', () => {
    const dir = tmp();
    write(dir, 'tests/a.test.ts');
    const t = resolveTarget({ repo: dir, paths: ['tests'], cwd: dir });
    expect(t.abstain).toBeNull();
    expect(paths(t)).toEqual(['tests/a.test.ts']);
  });
});
