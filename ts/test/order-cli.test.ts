/**
 * `canary order` end to end in a real git repository (#460 phase 2b): input
 * files from arguments or a file, the diff from `--base`, import proximity
 * from the test inventory, and the exit-code contract (0 plan, 2 bad input,
 * 3 abstained on no files).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

let repo: string;

function git(...args: string[]): string {
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
    { cwd: repo, encoding: 'utf-8' },
  ).trim();
}

function write(rel: string, body: string): string {
  const path = join(repo, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf-8');
  return path;
}

const FILES = ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts'];

beforeEach(() => {
  repo = mkTmp();
  git('init', '-q', '-b', 'main');
  for (const f of FILES) write(f, '');
  write('src/util.ts', 'export const x = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
});

afterEach(() => {
  rmTmp(repo);
});

interface Plan {
  mode: string;
  changedFiles: number | null;
  entries: { test_file: string; reasons: string[] }[];
}

async function order(
  args: string[],
): Promise<{ code: number; plan?: Plan; text: string }> {
  const res = await invokeCanary(['order', '--suite', 's', ...args], {
    cwd: repo,
  });
  const text = res.stdout + res.stderr;
  if (!args.includes('--json') || res.code !== 0)
    return { code: res.code, text };
  return { code: res.code, plan: JSON.parse(res.stdout) as Plan, text };
}

describe('canary order', () => {
  it('with no history and no diff emits the declaration order and exits 0', async () => {
    const res = await order([
      ...FILES,
      '--json',
      '--path',
      join(repo, 'h.jsonl'),
    ]);
    expect(res.code).toBe(0);
    expect(res.plan!.mode).toBe('declaration');
    expect(res.plan!.entries.map((e) => e.test_file)).toEqual(FILES);
  });

  it('ranks a file changed since --base first, and the diff count is stated', async () => {
    write('test/c.test.ts', '// edit\n');
    git('commit', '-q', '-am', 'edit c');
    const res = await order([...FILES, '--base', 'HEAD~1', '--json']);
    expect(res.code).toBe(0);
    expect(res.plan!.mode).toBe('diff-only');
    expect(res.plan!.changedFiles).toBe(1);
    expect(res.plan!.entries[0]).toMatchObject({
      test_file: 'test/c.test.ts',
      reasons: ['changed in diff'],
    });
  });

  it('uses the test inventory for import proximity', async () => {
    write(
      '.canary/test-inventory.json',
      JSON.stringify({
        schema_version: 1,
        generated: 'x',
        skipped: [],
        files: [
          {
            path: 'test/b.test.ts',
            framework: 'vitest',
            targets: ['src/util'],
            tests: [],
          },
        ],
      }),
    );
    git('add', '-A');
    git('commit', '-q', '-m', 'inventory');
    write('src/util.ts', 'export const x = 2;\n');
    git('commit', '-q', '-am', 'edit util');
    const res = await order([...FILES, '--base', 'HEAD~1', '--json']);
    expect(res.plan!.entries[0]).toMatchObject({
      test_file: 'test/b.test.ts',
      reasons: ['imports src/util.ts (changed)'],
    });
  });

  it('reads files from --files-from and makes them repo-relative', async () => {
    const list = write('files.txt', 'a.test.ts\n\nc.test.ts\n');
    const res = await invokeCanary(
      ['order', '--suite', 's', '--files-from', list, '--json'],
      { cwd: join(repo, 'test') },
    );
    expect(res.code).toBe(0);
    const plan = JSON.parse(res.stdout) as Plan;
    expect(plan.entries.map((e) => e.test_file)).toEqual([
      'test/a.test.ts',
      'test/c.test.ts',
    ]);
  });

  it('writes the plan to --out as JSON and prints a readable list', async () => {
    const out = join(repo, 'plan.json');
    const res = await order([...FILES, '--out', out]);
    expect(res.code).toBe(0);
    expect(res.text).toMatch(/mode: declaration/);
    expect(res.text).toContain('1. test/a.test.ts');
    const plan = JSON.parse(readFileSync(out, 'utf-8')) as Plan;
    expect(plan.entries).toHaveLength(3);
  });

  it('abstains with 3 when given no test files', async () => {
    const res = await order(['--json']);
    expect(res.code).toBe(3);
    expect(res.text).toMatch(/Abstained: no test files/);
  });

  it('exits 2 on an unreadable --files-from', async () => {
    const res = await order(['--files-from', join(repo, 'missing.txt')]);
    expect(res.code).toBe(2);
  });

  it('exits 2 on a --base that looks like an option', async () => {
    const res = await order([...FILES, '--base=--output=/tmp/x']);
    expect(res.code).toBe(2);
  });

  it('exits 2 on a --base that does not resolve', async () => {
    const res = await order([...FILES, '--base', 'no-such-ref']);
    expect(res.code).toBe(2);
    expect(res.text).toMatch(/no-such-ref/);
  });
});
