/**
 * The history join key (#1021, ADR 0029): `test_file` is stored relative to the
 * git top-level with `/` separators, so it equals a `git diff --name-only`
 * path. Anything that cannot be made so is KEPT and COUNTED, never dropped and
 * never guessed -- the count is the denominator a later join reports against.
 */

import { describe, expect, it } from 'vitest';

import type { TestResultInput } from '../src/history/schema.js';
import {
  normalizeTestFiles,
  playwrightBaseDir,
  toRepoRelative,
} from '../src/history/keys/test-file-key.js';

const TOP = '/work/repo';

function row(test_file: string): TestResultInput {
  return {
    run_id: 'r',
    suite: 's',
    repo: 'o/r',
    test_name: `t-${test_file}`,
    test_file,
    status: 'passed',
  };
}

describe('toRepoRelative', () => {
  it('makes an absolute path inside the repo repo-relative', () => {
    expect(
      toRepoRelative('/work/repo/ts/test/a.test.ts', { topLevel: TOP }),
    ).toBe('ts/test/a.test.ts');
  });

  it('resolves a relative path against the base directory first', () => {
    expect(
      toRepoRelative('checkout.spec.ts', {
        topLevel: TOP,
        baseDir: '/work/repo/e2e',
      }),
    ).toBe('e2e/checkout.spec.ts');
  });

  it('returns null for a path outside the repo', () => {
    expect(
      toRepoRelative('/home/runner/work/x/a.test.ts', { topLevel: TOP }),
    ).toBeNull();
  });

  it('keeps a file whose name merely starts with two dots', () => {
    expect(toRepoRelative('/work/repo/..fixture.ts', { topLevel: TOP })).toBe(
      '..fixture.ts',
    );
  });

  it('returns null for an empty path', () => {
    expect(toRepoRelative('', { topLevel: TOP, baseDir: TOP })).toBeNull();
  });

  it('returns null when there is no git top-level to be relative to', () => {
    expect(
      toRepoRelative('/work/repo/a.test.ts', { topLevel: null }),
    ).toBeNull();
  });

  it('returns null for a relative path whose base is unknown', () => {
    expect(toRepoRelative('checkout.spec.ts', { topLevel: TOP })).toBeNull();
  });

  it('returns null for the top-level itself, which is not a file key', () => {
    expect(toRepoRelative(TOP, { topLevel: TOP })).toBeNull();
  });
});

describe('normalizeTestFiles', () => {
  it('rewrites joinable rows and counts, but keeps, the unjoinable ones', () => {
    const { results, unjoinable } = normalizeTestFiles(
      [row('/work/repo/a.test.ts'), row(''), row('/elsewhere/b.test.ts')],
      { topLevel: TOP },
    );
    expect(results.map((r) => r.test_file)).toEqual([
      'a.test.ts',
      '',
      '/elsewhere/b.test.ts',
    ]);
    expect(unjoinable).toBe(2);
  });

  it('counts a row with no test_file at all as unjoinable', () => {
    const { test_file: _dropped, ...rest } = row('x');
    const bare = rest as TestResultInput;
    expect(normalizeTestFiles([bare], { topLevel: TOP }).unjoinable).toBe(1);
  });
});

describe('playwrightBaseDir', () => {
  it('reads the testDir Playwright resolved paths against (config.rootDir)', () => {
    expect(
      playwrightBaseDir({ config: { rootDir: '/work/repo/e2e' }, suites: [] }),
    ).toBe('/work/repo/e2e');
  });

  it('falls back to the first project testDir', () => {
    expect(
      playwrightBaseDir({
        config: { projects: [{ testDir: '/work/repo/pw' }] },
        suites: [],
      }),
    ).toBe('/work/repo/pw');
  });

  it('returns undefined when the report carries no config, rather than guessing', () => {
    expect(playwrightBaseDir({ suites: [] })).toBeUndefined();
  });
});
