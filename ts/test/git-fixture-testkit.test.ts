/**
 * Contract tests for `git-fixture-testkit.ts` (#1243, #1245).
 *
 * The testkit replaces a per-test `beforeEach` that spawned several `git`
 * processes with one build in `beforeAll` plus a file copy per test. That swap
 * is only safe if each copy is still a whole, independent repository: the
 * suites that use it commit, branch, push and add worktrees inside their copy,
 * and a write leaking into the template or into a sibling copy would make test
 * order matter. These tests pin exactly that.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  GIT_TEMPLATE_BUILD_TIMEOUT_MS,
  buildGitTemplate,
  copyGitTemplate,
  removeGitFixture,
} from './git-fixture-testkit.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'user.name=t',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf-8' },
  ).trim();
}

let template: string;
let head: string;

beforeAll(() => {
  template = buildGitTemplate('git-fixture-testkit-', (dir) => {
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'c1');
    head = git(dir, 'rev-parse', 'HEAD');
  });
}, GIT_TEMPLATE_BUILD_TIMEOUT_MS);

afterAll(() => removeGitFixture(template));

describe('copyGitTemplate', () => {
  it('yields a working repository at the template HEAD with a clean tree', () => {
    const copy = copyGitTemplate(template, 'git-fixture-copy-');
    try {
      expect(copy).not.toBe(template);
      expect(git(copy, 'rev-parse', 'HEAD')).toBe(head);
      expect(git(copy, 'status', '--porcelain')).toBe('');
    } finally {
      removeGitFixture(copy);
    }
  });

  it('isolates a copy: a commit in one is seen by neither the template nor a sibling', () => {
    const a = copyGitTemplate(template, 'git-fixture-copy-');
    const b = copyGitTemplate(template, 'git-fixture-copy-');
    try {
      writeFileSync(join(a, 'a.txt'), 'two\n');
      git(a, 'commit', '-q', '-am', 'c2');

      expect(git(a, 'rev-parse', 'HEAD')).not.toBe(head);
      expect(git(b, 'rev-parse', 'HEAD')).toBe(head);
      expect(git(template, 'rev-parse', 'HEAD')).toBe(head);
      expect(git(template, 'status', '--porcelain')).toBe('');
    } finally {
      removeGitFixture(a);
      removeGitFixture(b);
    }
  });
});

describe('buildGitTemplate', () => {
  it('removes its directory and rethrows when the build fails', () => {
    let seen = '';
    expect(() =>
      buildGitTemplate('git-fixture-broken-', (dir) => {
        seen = dir;
        throw new Error('build broke');
      }),
    ).toThrow('build broke');
    expect(seen).not.toBe('');
    expect(existsSync(seen)).toBe(false);
  });
});
