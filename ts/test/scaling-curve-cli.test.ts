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

  describe('--run with partial emission', () => {
    it('overrides a fittable verdict to INSUFFICIENT_DATA when any run dropped the metric', async () => {
      const out: string[] = [];
      const deps = { ...defaultMainDeps(), out: (s: string) => out.push(s) };
      let n = 0;
      // Every size still gets 2 of 3 samples, so the fit alone would succeed.
      const cmd = buildScalingCurveCommand(deps, (_s, size) =>
        (n += 1) % 3 === 0 ? null : size,
      );
      cmd.exitOverride();
      const err = await cmd
        .parseAsync(
          [
            '--run',
            'load.js',
            '--sizes',
            '1000,2000,4000,8000,16000',
            '--json',
          ],
          {
            from: 'user',
          },
        )
        .then(
          () => undefined,
          (e: { code?: unknown }) => e,
        );
      expect(err?.code).toBe(EXIT_ABSTAINED);
      const body = JSON.parse(out.join('\n'));
      expect(body.verdict).toBe('INSUFFICIENT_DATA');
      expect(body.reasons).toEqual([
        'metric http_req_duration:p(95) was not emitted by 5 run(s)',
      ]);
      expect(body.points).toHaveLength(5);
    });
  });

  describe('argument validation', () => {
    // Direct handler call: commander reports option-parse errors through its own
    // output hook and action errors by rejecting, so capture both.
    async function reject(args: string[]): Promise<string> {
      const deps = { ...defaultMainDeps(), out: () => undefined };
      const cmd = buildScalingCurveCommand(deps, () => 1);
      const errs: string[] = [];
      cmd.exitOverride().configureOutput({ writeErr: (s) => errs.push(s) });
      const e = await cmd.parseAsync(args, { from: 'user' }).then(
        () => undefined,
        (x: Error) => x,
      );
      expect(e).toBeInstanceOf(Error);
      return `${e?.message}\n${errs.join('')}`;
    }

    it('rejects a non-positive --target', async () => {
      expect(await reject(['points.csv', '--target', '0'])).toMatch(
        /must be a positive number, got "0"/,
      );
    });

    it('rejects a non-numeric entry in --sizes', async () => {
      expect(await reject(['--run', 'load.js', '--sizes', '1000,abc'])).toMatch(
        /must be a positive number, got "abc"/,
      );
    });

    it('refuses to run with neither a points file nor --run', async () => {
      expect(await reject([])).toMatch(
        /give a points file, or --run with --sizes/,
      );
    });

    it('refuses --run without --sizes', async () => {
      expect(await reject(['--run', 'load.js'])).toMatch(/--run needs --sizes/);
    });
  });

  describe.skipIf(process.platform === 'win32')('default k6 runner', () => {
    const SIZES = ['--sizes', '1000,2000,4000,8000,16000', '--repeats', '1'];

    it('abstains, not crashes, when k6 is not on PATH', async () => {
      const empty = mkTmp();
      try {
        const res = await invokeCanary(
          ['scaling-curve', '--run', 'load.js', ...SIZES],
          { env: { PATH: empty } },
        );
        expect(res.code).toBe(EXIT_ABSTAINED);
        expect(res.stdout).toMatch(/not emitted by 5 run\(s\)/);
      } finally {
        rmTmp(empty);
      }
    });

    it('reads trend:stat from the summary export k6 writes, passing SIZE', async () => {
      const bin = mkTmp();
      try {
        // Stand-in k6: value = SIZE^2 under the requested trend and stat.
        writeFileSync(
          join(bin, 'k6'),
          [
            '#!/bin/sh',
            'while [ $# -gt 0 ]; do',
            '  case "$1" in',
            '    --summary-export) out="$2"; shift ;;',
            '    -e) size="${2#SIZE=}"; shift ;;',
            '  esac; shift',
            'done',
            'v=$((size * size / 10000))',
            'printf \'{"metrics":{"iter":{"med":%s}}}\' "$v" > "$out"',
          ].join('\n'),
          { mode: 0o755 },
        );
        const res = await invokeCanary(
          [
            'scaling-curve',
            '--run',
            'load.js',
            ...SIZES,
            '--metric',
            'iter:med',
          ],
          { env: { PATH: bin } },
        );
        expect(res.code).toBe(0);
        expect(res.stdout).toMatch(/STRONGLY_SUPERLINEAR/);
        expect(res.stdout).toMatch(/Scaling curve: iter:med vs size/);
      } finally {
        rmTmp(bin);
      }
    });

    it('abstains when the export lacks the requested stat (default p(95))', async () => {
      const bin = mkTmp();
      try {
        writeFileSync(
          join(bin, 'k6'),
          [
            '#!/bin/sh',
            'while [ $# -gt 0 ]; do',
            '  [ "$1" = --summary-export ] && out="$2"',
            '  shift',
            'done',
            'printf \'{"metrics":{"iter":{"med":1}}}\' > "$out"',
          ].join('\n'),
          { mode: 0o755 },
        );
        const res = await invokeCanary(
          ['scaling-curve', '--run', 'load.js', ...SIZES, '--metric', 'iter'],
          { env: { PATH: bin } },
        );
        expect(res.code).toBe(EXIT_ABSTAINED);
        expect(res.stdout).toMatch(/metric iter was not emitted by 5 run\(s\)/);
      } finally {
        rmTmp(bin);
      }
    });
  });

  it('keeps --json parseable when it abstains', async () => {
    const res = await run('1000,1', ['--json']);
    expect(res.code).toBe(EXIT_ABSTAINED);
    expect(JSON.parse(res.stdout).verdict).toBe('INSUFFICIENT_DATA');
  });
});
