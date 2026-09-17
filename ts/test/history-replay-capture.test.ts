/**
 * `canary history record` captures replay context (#461, PR 1 of 3).
 *
 * Proposal 461 success criteria 1-3: a recorded run carries the seed it was
 * told about (and says where it came from), an environment fingerprint, the
 * source of its commit, and per-file start order where the report has it;
 * rows written before schema v3 still load.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  attachStartIndex,
  captureReplayContext,
  resolveCommit,
} from '../src/history/keys/replay-context.js';
import { NdjsonHistoryStore } from '../src/history/ndjson-store.js';
import { SCHEMA_VERSION } from '../src/history/record.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

const STORE = join('test-results', 'reports', 'history-v2.jsonl');

const HOST = { node: 'v22.23.2', os: 'linux', arch: 'x64' };

const LOCAL_ENV = {
  GITHUB_REPOSITORY: 'acme/widgets',
  GITHUB_REF_NAME: undefined,
  GITHUB_SHA: undefined,
  GITHUB_ACTIONS: undefined,
  CI: undefined,
};

function write(path: string, body: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf-8');
  return path;
}

interface StoredLine {
  schema_version: number;
  replay?: {
    seed: string | null;
    seed_source: string | null;
    runner: { name: string; version: string | null };
    node: string;
    os: string;
    arch: string;
    ci: string | null;
    commit_source: string | null;
  };
  tests: { test_file: string; start_index?: number }[];
}

function stored(cwd: string): StoredLine {
  const line = readFileSync(join(cwd, STORE), 'utf-8').trim();
  return JSON.parse(line) as StoredLine;
}

const vitestReport = (dir: string): string =>
  JSON.stringify({
    testResults: [
      {
        name: join(dir, 'b.test.ts'),
        startTime: 2000,
        assertionResults: [{ fullName: 'b', status: 'passed' }],
      },
      {
        name: join(dir, 'a.test.ts'),
        startTime: 1000,
        assertionResults: [{ fullName: 'a', status: 'failed' }],
      },
    ],
  });

describe('captureReplayContext', () => {
  it('records a flag seed with its source', () => {
    const ctx = captureReplayContext(
      { seed: '42', shape: 'vitest', parsed: {}, env: {}, commitSource: null },
      HOST,
    );
    expect(ctx).toMatchObject({ seed: '42', seed_source: 'flag' });
  });

  it('records seed and seed_source as null without a flag', () => {
    const ctx = captureReplayContext(
      { shape: 'vitest', parsed: {}, env: {}, commitSource: null },
      HOST,
    );
    expect(ctx).toMatchObject({ seed: null, seed_source: null });
  });

  it('treats an empty seed as no seed rather than a seed of ""', () => {
    const ctx = captureReplayContext(
      { seed: '', shape: 'vitest', parsed: {}, env: {}, commitSource: null },
      HOST,
    );
    expect(ctx).toMatchObject({ seed: null, seed_source: null });
  });

  it('fingerprints runner, node, os and arch', () => {
    const ctx = captureReplayContext(
      { shape: 'junit', parsed: '', env: {}, commitSource: null },
      HOST,
    );
    expect(ctx).toMatchObject({
      runner: { name: 'junit', version: null },
      node: 'v22.23.2',
      os: 'linux',
      arch: 'x64',
    });
  });

  it('reads the Playwright version from the report config', () => {
    const ctx = captureReplayContext(
      {
        shape: 'playwright',
        parsed: { config: { version: '1.55.0' }, suites: [] },
        env: {},
        commitSource: null,
      },
      HOST,
    );
    expect(ctx.runner).toEqual({ name: 'playwright', version: '1.55.0' });
  });

  it('names GitHub Actions, another CI, or no CI', () => {
    const ci = (env: Record<string, string | undefined>): string | null =>
      captureReplayContext(
        { shape: 'vitest', parsed: {}, env, commitSource: null },
        HOST,
      ).ci;
    expect(ci({ GITHUB_ACTIONS: 'true', CI: 'true' })).toBe('github-actions');
    expect(ci({ CI: 'true' })).toBe('other');
    expect(ci({ CI: 'false' })).toBeNull();
    expect(ci({})).toBeNull();
  });

  it('never copies an environment value it was not asked for', () => {
    const ctx = captureReplayContext(
      {
        shape: 'vitest',
        parsed: {},
        env: { SECRET_TOKEN: 'hunter2', GITHUB_ACTIONS: 'true' },
        commitSource: null,
      },
      HOST,
    );
    expect(JSON.stringify(ctx)).not.toContain('hunter2');
  });
});

describe('resolveCommit', () => {
  const noGit = { git: (): string | null => null };
  const headGit = { git: (): string | null => 'f'.repeat(40) };
  const quiet = (): void => undefined;

  it('attributes an explicit --commit to the flag', () => {
    expect(resolveCommit('abc', { GITHUB_SHA: 'def' }, headGit, quiet)).toEqual(
      { sha: 'abc', source: 'flag' },
    );
  });

  it('attributes the CI commit to GITHUB_SHA', () => {
    expect(
      resolveCommit(undefined, { GITHUB_SHA: 'def' }, headGit, quiet),
    ).toEqual({ sha: 'def', source: 'GITHUB_SHA' });
  });

  it('attributes a resolved HEAD to HEAD', () => {
    expect(resolveCommit(undefined, {}, headGit, quiet)).toEqual({
      sha: 'f'.repeat(40),
      source: 'HEAD',
    });
  });

  it('leaves local with a null source, which makes the run non-replayable', () => {
    expect(resolveCommit(undefined, {}, noGit, quiet)).toEqual({
      sha: 'local',
      source: null,
    });
    expect(resolveCommit('local', {}, noGit, quiet)).toEqual({
      sha: 'local',
      source: null,
    });
  });
});

describe('attachStartIndex', () => {
  const row = (file: string): { test_file: string; start_index?: number } => ({
    test_file: file,
  });

  it('ranks vitest files by their startTime', () => {
    const parsed = JSON.parse(vitestReport('/r')) as unknown;
    const out = attachStartIndex(
      [row('/r/b.test.ts'), row('/r/a.test.ts')],
      'vitest',
      parsed,
    );
    expect(out.map((r) => r.start_index)).toEqual([1, 0]);
  });

  it('ranks Playwright files by their earliest attempt start', () => {
    const spec = (file: string, start: string): unknown => ({
      title: file,
      file,
      specs: [
        {
          title: 't',
          tests: [{ status: 'expected', results: [{ startTime: start }] }],
        },
      ],
    });
    const parsed = {
      suites: [
        spec('late.spec.ts', '2026-09-16T10:00:05.000Z'),
        spec('early.spec.ts', '2026-09-16T10:00:01.000Z'),
      ],
    };
    const out = attachStartIndex(
      [row('late.spec.ts'), row('early.spec.ts')],
      'playwright',
      parsed,
    );
    expect(out.map((r) => r.start_index)).toEqual([1, 0]);
  });

  it('attaches nothing when the report carries no start times', () => {
    const parsed = {
      testResults: [{ name: '/r/a.test.ts', assertionResults: [] }],
    };
    const out = attachStartIndex([row('/r/a.test.ts')], 'vitest', parsed);
    expect(out[0]).not.toHaveProperty('start_index');
  });

  it('attaches nothing for JUnit, whose order is not recorded', () => {
    const out = attachStartIndex([row('x.py')], 'junit', '<testsuite/>');
    expect(out[0]).not.toHaveProperty('start_index');
  });
});

describe('history record: replay capture end to end (#461)', () => {
  it('criterion 1: --seed 42 is stored as seed "42" from the flag', async () => {
    const dir = mkTmp();
    try {
      const report = write(join(dir, 'v.json'), vitestReport(dir));
      const res = await invokeCanary(
        ['history', 'record', report, '--suite', 's', '--seed', '42'],
        { cwd: dir, env: LOCAL_ENV },
      );
      expect(res.code).toBe(0);
      expect(stored(dir).replay).toMatchObject({
        seed: '42',
        seed_source: 'flag',
      });
    } finally {
      rmTmp(dir);
    }
  });

  it('criterion 1: without --seed both seed fields are null', async () => {
    const dir = mkTmp();
    try {
      const report = write(join(dir, 'v.json'), vitestReport(dir));
      const res = await invokeCanary(
        ['history', 'record', report, '--suite', 's'],
        { cwd: dir, env: LOCAL_ENV },
      );
      expect(res.code).toBe(0);
      expect(stored(dir).replay).toMatchObject({
        seed: null,
        seed_source: null,
      });
    } finally {
      rmTmp(dir);
    }
  });

  it('criterion 2: every record carries the fingerprint and schema v3', async () => {
    const dir = mkTmp();
    try {
      const report = write(join(dir, 'v.json'), vitestReport(dir));
      const res = await invokeCanary(
        ['history', 'record', report, '--suite', 's', '--commit', 'abc123'],
        { cwd: dir, env: LOCAL_ENV },
      );
      expect(res.code).toBe(0);
      const line = stored(dir);
      expect(line.schema_version).toBe(3);
      expect(line.replay).toMatchObject({
        runner: { name: 'vitest', version: null },
        node: process.version,
        os: process.platform,
        arch: process.arch,
        ci: null,
        commit_source: 'flag',
      });
    } finally {
      rmTmp(dir);
    }
  });

  it('criterion 2: stored test files inside a repo never start with / or a drive letter', async () => {
    const repo = mkTmp();
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      // Real files: the keyer resolves symlinks (macOS /var -> /private/var)
      // only for paths that exist.
      write(join(repo, 'a.test.ts'), '');
      write(join(repo, 'b.test.ts'), '');
      const report = write(join(repo, 'v.json'), vitestReport(repo));
      const res = await invokeCanary(
        ['history', 'record', report, '--suite', 's', '--commit', 'abc123'],
        { cwd: repo, env: LOCAL_ENV },
      );
      expect(res.code).toBe(0);
      const files = stored(repo).tests.map((t) => t.test_file);
      expect(files).toEqual(['b.test.ts', 'a.test.ts']);
      for (const f of files) expect(f).not.toMatch(/^(\/|[A-Za-z]:)/);
      expect(stored(repo).tests.map((t) => t.start_index)).toEqual([1, 0]);
    } finally {
      rmTmp(repo);
    }
  });

  it('criterion 3: a store holding a v2 row and a v3 row loads both', () => {
    const dir = mkTmp();
    try {
      const path = join(dir, 'h.jsonl');
      const legacy = { run_id: 'old', suite: 's', tests: [] };
      const v2 = { schema_version: 2, run_id: 'v2', suite: 's', tests: [] };
      const v3 = {
        schema_version: SCHEMA_VERSION,
        run_id: 'v3',
        suite: 's',
        replay: { seed: null },
        tests: [],
      };
      writeFileSync(
        path,
        [legacy, v2, v3].map((r) => JSON.stringify(r)).join('\n') + '\n',
      );
      const runs = new NdjsonHistoryStore(path).readAll();
      expect(runs.map((r) => r.run_id)).toEqual(['old', 'v2', 'v3']);
      expect(runs[0]!.replay).toBeUndefined();
    } finally {
      rmTmp(dir);
    }
  });

  it('still refuses a version newer than this build understands', () => {
    const dir = mkTmp();
    try {
      const path = join(dir, 'h.jsonl');
      writeFileSync(
        path,
        JSON.stringify({ schema_version: 4, run_id: 'x', suite: 's' }) + '\n',
      );
      expect(() => new NdjsonHistoryStore(path).readAll()).toThrow(
        /Unsupported history schema_version 4/,
      );
    } finally {
      rmTmp(dir);
    }
  });
});
