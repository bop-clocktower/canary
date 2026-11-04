/**
 * What `canary critical-areas` asks git (#1529), against real repositories. The
 * 2020 commit dates prove the churn window is anchored to HEAD: a wall-clock
 * window would read 0 for all of them.
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readGitFacts,
  type GitFacts,
} from '../src/critical-areas/git-signals.js';
import { mkTmp, rmTmp } from './canary-cli-testkit.js';

function git(
  cwd: string,
  args: string[],
  date = '2020-06-01T00:00:00Z',
): string {
  // GIT_DIR-style variables inside a pre-commit hook would point git at this
  // repository instead of the fixture.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
  );
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf-8',
      env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    },
  );
}

function commit(
  root: string,
  files: Record<string, string>,
  date?: string,
): void {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body, 'utf-8');
  }
  git(root, ['add', '-A'], date);
  git(root, ['commit', '-m', 'c', '--allow-empty'], date);
}

function facts(root: string): GitFacts {
  const read = readGitFacts(root);
  if (!read.ok) throw new Error(read.reason);
  return read;
}

describe('readGitFacts', () => {
  let root: string;
  beforeEach(() => {
    root = mkTmp();
  });
  afterEach(() => {
    rmTmp(root);
  });

  it('reports a directory outside any repository', () => {
    const read = readGitFacts(root);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toMatch(/git repository/);
  });

  it('reports a repository with no commit', () => {
    git(root, ['init', '-q']);
    const read = readGitFacts(root);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toMatch(/no commit/);
  });

  it('resolves a subdirectory to the top level and the full HEAD sha (D16)', () => {
    git(root, ['init', '-q']);
    commit(root, { 'src/a.ts': 'export {};\n' });
    const f = facts(join(root, 'src'));
    expect(realpathSync(f.top)).toBe(realpathSync(root));
    expect(f.head).toMatch(/^[0-9a-f]{40}$/);
  });

  describe('candidate filter', () => {
    const IN = ['src/a.ts', 'src/a.tsx', 'lib/b.mjs', 'app/c.py', 'web/d.php'];
    const OUT = [
      'src/a.test.ts',
      'src/a.spec.js',
      'tests/x.py',
      'test/x.ts',
      '__tests__/x.js',
      'test_x.py',
      'x_test.py',
      'conftest.py',
      'FooTest.php',
      'test/fixtures/y.ts',
      'vendor/z.php',
      'node_modules/z.js',
      'dist/z.js',
      'build/z.js',
      'src/types.d.ts',
      'src/a.min.js',
      'README.md',
    ];

    function single(path: string): GitFacts {
      git(root, ['init', '-q']);
      commit(root, { [path]: 'x\n' });
      return facts(root);
    }

    it.each(IN)('%s is a candidate', (path) => {
      expect(single(path).candidates).toEqual([path]);
    });

    it.each(OUT)('%s is not a candidate, though it is tracked', (path) => {
      const f = single(path);
      expect(f.candidates).toEqual([]);
      expect(f.tracked).toEqual([path]);
    });
  });

  it('anchors the churn window to HEAD, not the wall clock (D8)', () => {
    git(root, ['init', '-q']);
    commit(root, { 'src/a.ts': '1\n' }, '2020-01-01T00:00:00Z');
    commit(root, { 'src/a.ts': '2\n' }, '2020-05-01T00:00:00Z');
    commit(root, { 'src/b.ts': '3\n' }, '2020-06-01T00:00:00Z');
    const churn = facts(root).churn!;
    expect(churn.get('src/a.ts')).toBe(1);
    expect(churn.get('src/b.ts')).toBe(1);
  });

  it('keeps walking past a backdated commit in the window (D8)', () => {
    git(root, ['init', '-q']);
    commit(root, { 'src/early.ts': '1\n' }, '2020-05-01T00:00:00Z');
    commit(root, { 'src/old.ts': '1\n' }, '2019-01-01T00:00:00Z');
    commit(root, { 'src/mid.ts': '1\n' }, '2020-05-10T00:00:00Z');
    commit(root, { 'src/late.ts': '1\n' }, '2020-06-01T00:00:00Z');
    const churn = facts(root).churn!;
    expect(churn.get('src/late.ts')).toBe(1);
    expect(churn.get('src/mid.ts')).toBe(1);
    expect(churn.get('src/early.ts')).toBe(1);
    expect(churn.has('src/old.ts')).toBe(false);
  });

  it('reads a failed git log as unmeasured churn with a reason', () => {
    git(root, ['init', '-q']);
    commit(root, { 'src/a.ts': '1\n' });
    const parent = git(root, ['rev-parse', 'HEAD']).trim();
    commit(root, { 'src/a.ts': '2\n' });
    rmSync(join(root, '.git', 'objects', parent.slice(0, 2), parent.slice(2)));
    const f = facts(root);
    expect(f.churn).toBeNull();
    expect(f.churnAbsentReason).toMatch(/git log failed/);
  });

  it('gives no reason when churn was measured', () => {
    git(root, ['init', '-q']);
    commit(root, { 'src/a.ts': '1\n' });
    expect(facts(root).churnAbsentReason).toBeNull();
  });

  it('keeps a file name with a space whole', () => {
    git(root, ['init', '-q']);
    commit(root, { 'src/a b.ts': '1\n', 'src/c.ts': '1\n' });
    commit(root, { 'src/a b.ts': '2\n' });
    const f = facts(root);
    expect(f.candidates).toContain('src/a b.ts');
    expect(f.churn!.get('src/a b.ts')).toBe(2);
    expect(f.churn!.get('src/c.ts')).toBe(1);
  });

  it('reads a shallow clone as unmeasured churn (D9)', () => {
    git(root, ['init', '-q']);
    commit(root, { 'src/a.ts': '1\n' });
    commit(root, { 'src/a.ts': '2\n' });
    const clone = join(root, 'clone');
    git(dirname(root), [
      'clone',
      '-q',
      '--depth',
      '1',
      `file://${root}`,
      clone,
    ]);
    const f = facts(clone);
    expect(f.churn).toBeNull();
    expect(f.churnAbsentReason).toMatch(/shallow/);
    expect(f.candidates).toEqual(['src/a.ts']);
  });

  describe("the user's git config must not change the read", () => {
    it('counts root-commit files under log.showRoot=false', () => {
      git(root, ['init', '-q']);
      commit(root, { 'src/a.ts': '1\n', 'src/b.ts': '1\n' });
      commit(root, { 'src/a.ts': '2\n' });
      const before = facts(root).churn;
      git(root, ['config', 'log.showRoot', 'false']);
      const after = facts(root).churn!;
      expect(after).toEqual(before);
      expect(after.get('src/a.ts')).toBe(2);
      expect(after.get('src/b.ts')).toBe(1);
    });

    /** A real signature: without one, showSignature prints nothing to break. */
    function signedHead(): void {
      git(root, ['init', '-q']);
      const key = join(root, '.git', 'test-signing-key');
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
      git(root, ['config', 'gpg.format', 'ssh']);
      git(root, ['config', 'user.signingkey', `${key}.pub`]);
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src', 'a.ts'), '1\n', 'utf-8');
      git(root, ['add', '-A']);
      git(root, ['commit', '-S', '-m', 'signed']);
      git(root, ['config', 'log.showSignature', 'true']);
    }

    it('reads a signed HEAD under log.showSignature=true', () => {
      signedHead();
      const f = facts(root);
      expect(f.churnAbsentReason).toBeNull();
      // Signature text in the log output would also read as paths.
      expect([...f.churn!.entries()]).toEqual([['src/a.ts', 1]]);
    });
  });

  describe('an unparsable HEAD commit time', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    /** A `git` on PATH that answers `show` with `answer`, and is real otherwise. */
    function gitAnsweringShowWith(answer: string): void {
      const bin = join(root, 'stub-bin');
      mkdirSync(bin);
      const stub = join(bin, 'git');
      writeFileSync(
        stub,
        `#!/bin/sh
case "$*" in
  *"show -s"*) printf '%s\\n' '${answer}'; exit 0 ;;
esac
PATH='${process.env.PATH}' exec git "$@"
`,
        'utf-8',
      );
      chmodSync(stub, 0o755);
      vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    }

    it.each([
      ['text', 'gpg: Good signature'],
      ['nothing', ''],
      ['a time past what Date can hold', '99999999999999999'],
    ])('reads %s as unmeasured churn, not a throw', (_name, answer) => {
      git(root, ['init', '-q']);
      commit(root, { 'src/a.ts': '1\n' });
      gitAnsweringShowWith(answer);
      const f = facts(root);
      expect(f.churn).toBeNull();
      expect(f.churnAbsentReason).toMatch(/commit time/);
    });
  });
});
