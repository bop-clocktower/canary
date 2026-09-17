/**
 * The vitest adapter for `canary order` (#460 phase 3): it sorts real
 * `TestSpecification`-shaped files by a plan, keeps every one, and is exported
 * from the published package at the path the build stages it to.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TestSpecification, Vitest } from 'vitest/node';
import { afterEach, describe, expect, it } from 'vitest';

import CanaryOrderSequencer from '../src/analysis/order/vitest-sequencer.js';
import { mkTmp, rmTmp } from './canary-cli-testkit.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOP = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf-8',
}).trim();

const spec = (rel: string): TestSpecification =>
  ({ moduleId: join(TOP, rel) }) as TestSpecification;

afterEach(() => {
  delete process.env['CANARY_ORDER_PLAN'];
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
