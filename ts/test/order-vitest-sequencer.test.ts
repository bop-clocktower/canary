/**
 * The vitest adapter for `canary order` (#460 phase 3): it sorts real
 * `TestSpecification`-shaped files by a plan, keeps every one, and is exported
 * from the published package at the path the build stages it to.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BaseSequencer,
  type TestSpecification,
  type Vitest,
} from 'vitest/node';
import { afterEach, describe, expect, it, vi } from 'vitest';

import CanaryOrderSequencer from '../src/analysis/order/vitest-sequencer.js';
import { mkTmp, rmTmp } from './canary-cli-testkit.js';

// `git rev-parse` is real unless a test sets `gitFails`, which makes the
// sequencer's own lookup throw so its cwd fallback is the root it uses.
const git = vi.hoisted(() => ({ fails: false }));
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    execFileSync: ((...args: Parameters<typeof real.execFileSync>) => {
      if (git.fails) throw new Error('not a git repository');
      return real.execFileSync(...args);
    }) as typeof real.execFileSync,
  };
});

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOP = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf-8',
}).trim();

const spec = (rel: string): TestSpecification =>
  ({ moduleId: join(TOP, rel) }) as TestSpecification;

afterEach(() => {
  delete process.env['CANARY_ORDER_PLAN'];
  git.fails = false;
  vi.restoreAllMocks();
});

/**
 * The fallbacks (#1752): an unusable plan must never block or shrink a run, so
 * every one of them hands the files to vitest's own order unchanged. The base
 * sort is stubbed to a recognisable marker, because the real one needs a live
 * Vitest context.
 */
describe('CanaryOrderSequencer fallbacks', () => {
  const files = ['b', 'a'].map((n) => spec(`ts/test/${n}.test.ts`));
  const VITEST_ORDER = [...files].reverse();

  function stubBaseSort() {
    return vi
      .spyOn(BaseSequencer.prototype, 'sort')
      .mockResolvedValue(VITEST_ORDER);
  }

  it('defers to vitest when CANARY_ORDER_PLAN is unset, writing nothing', async () => {
    const base = stubBaseSort();
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const out = await new CanaryOrderSequencer({} as Vitest).sort(files);
    expect(out).toBe(VITEST_ORDER);
    expect(base).toHaveBeenCalledWith(files);
    expect(stderr).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing file', (dir: string) => join(dir, 'absent.json')],
    [
      'a file that is not JSON',
      (dir: string) => {
        const p = join(dir, 'plan.json');
        writeFileSync(p, '{not json');
        return p;
      },
    ],
    [
      'JSON without an entries array',
      (dir: string) => {
        const p = join(dir, 'plan.json');
        writeFileSync(p, JSON.stringify({ entries: 'no' }));
        return p;
      },
    ],
  ])(
    'defers to vitest and says why on stderr for %s',
    async (_label, plant) => {
      const dir = mkTmp();
      try {
        const path = plant(dir);
        process.env['CANARY_ORDER_PLAN'] = path;
        const base = stubBaseSort();
        const stderr = vi
          .spyOn(process.stderr, 'write')
          .mockImplementation(() => true);
        const out = await new CanaryOrderSequencer({} as Vitest).sort(files);
        expect(out).toBe(VITEST_ORDER);
        expect(base).toHaveBeenCalledWith(files);
        expect(stderr).toHaveBeenCalledWith(
          `canary order: ${path} is not a readable order plan; using vitest's order.\n`,
        );
      } finally {
        rmTmp(dir);
      }
    },
  );

  it('resolves plan paths against the cwd when git cannot name a repo root', async () => {
    const dir = mkTmp();
    try {
      const plan = join(dir, 'plan.json');
      writeFileSync(
        plan,
        JSON.stringify({
          entries: [{ test_file: 'z.test.ts', score: 1, reasons: [] }],
        }),
      );
      process.env['CANARY_ORDER_PLAN'] = plan;
      git.fails = true;
      const inCwd = (n: string): TestSpecification =>
        ({ moduleId: join(process.cwd(), n) }) as TestSpecification;
      const out = await new CanaryOrderSequencer({} as Vitest).sort([
        inCwd('y.test.ts'),
        inCwd('z.test.ts'),
      ]);
      expect(out.map((f) => f.moduleId)).toEqual([
        join(process.cwd(), 'z.test.ts'),
        join(process.cwd(), 'y.test.ts'),
      ]);
    } finally {
      rmTmp(dir);
    }
  });

  it('keeps every specification when two share a module id', async () => {
    const dir = mkTmp();
    try {
      const plan = join(dir, 'plan.json');
      writeFileSync(plan, JSON.stringify({ entries: [] }));
      process.env['CANARY_ORDER_PLAN'] = plan;
      const first = spec('ts/test/dup.test.ts');
      const second = spec('ts/test/dup.test.ts');
      const out = await new CanaryOrderSequencer({} as Vitest).sort([
        first,
        second,
      ]);
      expect(out).toHaveLength(2);
      expect(out[0]).toBe(first);
      expect(out[1]).toBe(second);
    } finally {
      rmTmp(dir);
    }
  });
});

describe('CanaryOrderSequencer', () => {
  it('sorts files by the plan named in CANARY_ORDER_PLAN, keeping every file', async () => {
    const dir = mkTmp();
    try {
      const plan = join(dir, 'plan.json');
      writeFileSync(
        plan,
        JSON.stringify({
          entries: [
            { test_file: 'ts/test/c.test.ts', score: 1, reasons: ['r'] },
            { test_file: 'ts/test/a.test.ts', score: 0, reasons: [] },
          ],
        }),
      );
      process.env['CANARY_ORDER_PLAN'] = plan;
      const files = ['a', 'new', 'c'].map((n) => spec(`ts/test/${n}.test.ts`));
      const sequencer = new CanaryOrderSequencer({} as Vitest);
      const out = await sequencer.sort(files);
      expect(out.map((f) => f.moduleId)).toEqual([
        join(TOP, 'ts/test/c.test.ts'),
        join(TOP, 'ts/test/a.test.ts'),
        join(TOP, 'ts/test/new.test.ts'),
      ]);
      expect(out).toHaveLength(3);
    } finally {
      rmTmp(dir);
    }
  });
});

describe('published export', () => {
  it('points ./vitest-sequencer at the staged engine path of the source module', () => {
    const pkg = JSON.parse(
      readFileSync(join(REPO, 'npm', 'package.json'), 'utf-8'),
    ) as {
      exports: Record<string, { import: string }>;
      peerDependenciesMeta: Record<string, { optional: boolean }>;
    };
    expect(pkg.exports['./vitest-sequencer']?.import).toBe(
      './dist/engine/analysis/order/vitest-sequencer.js',
    );
    expect(pkg.peerDependenciesMeta['vitest']).toEqual({ optional: true });
    // build-engine stages ts/dist -> dist/engine, so the export must mirror
    // the source path under ts/src.
    expect(() =>
      readFileSync(
        join(REPO, 'ts', 'src', 'analysis', 'order', 'vitest-sequencer.ts'),
      ),
    ).not.toThrow();
  });
});
