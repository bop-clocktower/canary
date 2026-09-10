/**
 * `canary scaling-curve <points-file>` (#856).
 *
 * Advisory: a verdict exits 0 whatever the exponent, because this is a planning
 * signal, not a gate. An abstention exits 3 (ADR 0009) -- "not enough data to
 * say" must never look like "linear".
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command, InvalidArgumentError } from 'commander';
import pc from 'picocolors';

import { CliExitError, jsonIndent2 } from './cli-common.js';
import { EXIT_ABSTAINED } from './core/gate-result.js';
import { fitScaling, parsePoints, type Point } from './core/scaling-curve.js';
import { WARN, type MainDeps } from './main-deps.js';

const MEANING: Record<string, string> = {
  LINEAR_OR_BETTER: 'cost grows no faster than input',
  SUPERLINEAR: 'cost grows faster than input (n log n territory)',
  STRONGLY_SUPERLINEAR:
    'cost grows much faster than input (quadratic territory) -- will buckle at peak',
};

function positive(raw: string): number {
  const n = Number(raw);
  if (!(Number.isFinite(n) && n > 0)) {
    throw new InvalidArgumentError(`must be a positive number, got "${raw}"`);
  }
  return n;
}

/**
 * Runs one load iteration at `size` and returns the metric, or `null` when the
 * run did not emit it. Injectable so tests never need k6 on PATH.
 */
export type K6Runner = (
  script: string,
  size: number,
  metric: string,
) => number | null;

/** `trend:stat`, e.g. `http_req_duration:p(95)`, read from k6's summary export. */
export const defaultK6Runner: K6Runner = (script, size, metric) => {
  const [trend, stat = 'p(95)'] = metric.split(':');
  const dir = mkdtempSync(join(tmpdir(), 'canary-scaling-'));
  try {
    const summary = join(dir, 'summary.json');
    const res = spawnSync(
      'k6',
      [
        'run',
        '--quiet',
        '--summary-export',
        summary,
        '-e',
        `SIZE=${size}`,
        script,
      ],
      // k6's own end summary would bury the verdict; its errors still show.
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
    if (res.error) throw res.error;
    const j = JSON.parse(readFileSync(summary, 'utf-8')) as {
      metrics?: Record<string, Record<string, number>>;
    };
    const v = j.metrics?.[trend!]?.[stat];
    return typeof v === 'number' ? v : null;
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return null;
    throw e;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

function sizeList(raw: string): number[] {
  const sizes = raw.split(',').map((s) => positive(s.trim()));
  return sizes;
}

export function buildScalingCurveCommand(
  deps: MainDeps,
  runner: K6Runner = defaultK6Runner,
): Command {
  return new Command('scaling-curve')
    .description(
      'Fit how a cost metric grows with input size; flag superlinear growth. ' +
        'Advisory; abstains (exit 3) when the data cannot support a verdict.',
    )
    .argument(
      '[points-file]',
      'JSON {"metric","points":[{size,value}]} or CSV with a size,value header',
    )
    .option(
      '--target <size>',
      'extrapolate the fitted cost to this size',
      positive,
    )
    .option(
      '--run <k6-script>',
      'run the ladder: the script once per size with SIZE set',
    )
    .option('--sizes <list>', 'comma-separated sizes for --run', sizeList)
    .option(
      '--repeats <n>',
      'runs per size for --run (noise rule)',
      positive,
      3,
    )
    .option(
      '--metric <trend:stat>',
      'k6 metric for --run',
      'http_req_duration:p(95)',
    )
    .option('--json', 'Output the verdict and its points as JSON.')
    .action((file: string | undefined, opts: ScalingOpts) => {
      const { metric, points, missing } = collect(file, opts, runner);
      let r = fitScaling(
        points,
        opts.target === undefined ? {} : { target: opts.target },
      );

      // A run that never emitted the metric is an abstention even if the other
      // runs would fit: the missing runs are a hole in the curve, not a zero.
      if (missing > 0 && r.verdict === 'INSUFFICIENT_DATA') {
        r.reasons.unshift(
          `metric ${metric} was not emitted by ${missing} run(s)`,
        );
      }
      if (missing > 0 && r.verdict !== 'INSUFFICIENT_DATA') {
        r = {
          verdict: 'INSUFFICIENT_DATA',
          reasons: [`metric ${metric} was not emitted by ${missing} run(s)`],
          points: r.points,
        };
      }
      const abstained = r.verdict === 'INSUFFICIENT_DATA';

      if (opts.json) {
        deps.out(jsonIndent2({ metric: metric ?? null, ...r }));
      } else {
        const label = metric ?? 'value';
        deps.out(pc.bold(`Scaling curve: ${label} vs size`));
        for (const p of r.points) {
          deps.out(
            `  ${String(p.size).padStart(10)}  ${Number(p.value.toPrecision(4))}  ${pc.dim(`(${p.samples} sample(s))`)}`,
          );
        }
        if (r.verdict === 'INSUFFICIENT_DATA') {
          deps.out(
            pc.bold(
              pc.yellow(`${WARN} INSUFFICIENT_DATA -- this is not a pass.`),
            ),
          );
          for (const reason of r.reasons) deps.out(`  - ${reason}`);
        } else {
          const color = r.verdict === 'LINEAR_OR_BETTER' ? pc.green : pc.yellow;
          deps.out(
            `${color(pc.bold(r.verdict))}: exponent ${r.exponent.toFixed(2)} ` +
              `(R² ${r.r2.toFixed(3)}) -- ${MEANING[r.verdict]}`,
          );
          deps.out(
            r.knee === null
              ? '  no knee: the curve does not bend within the measured range'
              : `  knee at size ${r.knee}: growth steepens from here`,
          );
          if (r.extrapolation) {
            const e = r.extrapolation;
            deps.out(
              `  extrapolated ${label} at ${e.size}: ${e.value.toFixed(1)} ` +
                pc.dim(
                  `(${e.multipleOfLargest}x the largest measured size -- an extrapolation, not a measurement)`,
                ),
            );
          }
        }
      }
      if (abstained) throw new CliExitError(EXIT_ABSTAINED);
    });
}

interface ScalingOpts {
  target?: number;
  json?: boolean;
  run?: string;
  sizes?: number[];
  repeats: number;
  metric: string;
}

function collect(
  file: string | undefined,
  opts: ScalingOpts,
  runner: K6Runner,
): { metric?: string; points: Point[]; missing: number } {
  if (opts.run === undefined) {
    if (file === undefined) {
      throw new InvalidArgumentError(
        'give a points file, or --run with --sizes',
      );
    }
    return { ...parsePoints(readFileSync(file, 'utf-8')), missing: 0 };
  }
  if (!opts.sizes) throw new InvalidArgumentError('--run needs --sizes');
  const points: Point[] = [];
  let missing = 0;
  for (const size of opts.sizes) {
    for (let i = 0; i < opts.repeats; i += 1) {
      const value = runner(opts.run, size, opts.metric);
      if (value === null) missing += 1;
      else points.push({ size, value });
    }
  }
  return { metric: opts.metric, points, missing };
}
