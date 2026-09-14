/**
 * `canary scaling-curve` (#856): advisory on a verdict (exit 0), loud on an
 * abstention (exit 3), parseable JSON either way.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXIT_ABSTAINED } from '../src/core/gate-result.js';
import { defaultMainDeps } from '../src/main-deps.js';
import {
  buildScalingCurveCommand,
  type K6Runner,
} from '../src/scaling-curve-cli.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

const QUADRATIC = [1000, 2000, 4000, 8000, 16000]
  .map((n) => `${n},${(n * n) / 1e4}`)
  .join('\n');

async function run(csv: string, args: string[] = []) {
  const home = mkTmp();
  try {
    const f = join(home, 'points.csv');
    writeFileSync(f, `size,value\n${csv}\n`, 'utf-8');
    return await invokeCanary(['scaling-curve', f, ...args]);
  } finally {
    rmTmp(home);
  }
}

describe('canary scaling-curve', () => {
  it('reports the exponent and exits 0 — advisory, not a gate', async () => {
    const res = await run(QUADRATIC, ['--target', '160000']);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/STRONGLY_SUPERLINEAR/);
    expect(res.stdout).toMatch(/exponent 2\.00/);
    expect(res.stdout).toMatch(/10x the largest measured size/);
  });

  it('exits 3 and names the rule when the data cannot support a verdict', async () => {
    const res = await run('1000,1\n2000,2\n4000,4');
    expect(res.code).toBe(EXIT_ABSTAINED);
    expect(res.stdout).toMatch(/INSUFFICIENT_DATA/);
    expect(res.stdout).toMatch(/4 distinct sizes/);
  });

  describe('--run (Phase 2: produces the points itself)', () => {
    async function runWith(runner: K6Runner, extra: string[] = []) {
      const out: string[] = [];
      const deps = { ...defaultMainDeps(), out: (s: string) => out.push(s) };
      const cmd = buildScalingCurveCommand(deps, runner);
      cmd.exitOverride();
      let code = 0;
      try {
        await cmd.parseAsync(
          [
            '--run',
            'load.js',
            '--sizes',
            '1000,2000,4000,8000,16000',
            ...extra,
          ],
          { from: 'user' },
        );
      } catch (e) {
        // CliExitError carries `code`; commander's own errors carry `exitCode`.
        const err = e as { code?: unknown; exitCode?: number };
        code = typeof err.code === 'number' ? err.code : (err.exitCode ?? 1);
      }
      return { code, stdout: out.join('\n') };
    }

    it('runs every size x repeat with SIZE set, then fits the same way', async () => {
      const calls: number[] = [];
      const res = await runWith((_script, size) => {
        calls.push(size);
        return (size * size) / 1e4;
      });
      expect(calls).toHaveLength(15);
      expect(new Set(calls)).toEqual(new Set([1000, 2000, 4000, 8000, 16000]));
      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(/STRONGLY_SUPERLINEAR/);
    });

    it('abstains when the run never emitted the metric — a missing metric is not a zero', async () => {
      const res = await runWith(() => null);
      expect(res.code).toBe(EXIT_ABSTAINED);
      expect(res.stdout).toMatch(/metric .* was not emitted/);
    });
  });

  it('keeps --json parseable when it abstains', async () => {
    const res = await run('1000,1', ['--json']);
    expect(res.code).toBe(EXIT_ABSTAINED);
    expect(JSON.parse(res.stdout).verdict).toBe('INSUFFICIENT_DATA');
  });
});
