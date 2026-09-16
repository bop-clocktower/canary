/**
 * Throwaway spike driver for #765 D2. NOT engine code.
 *
 * Spawns measure-cold.mjs once per run per scenario (cold per process) and
 * reports min / median / max. Usage:
 *
 *   node run-cold.mjs [--runs 5] [--ts <typescript install root>]
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const RUNS = Number(opt('runs', '5'));
const tsRoot = opt('ts', undefined);
const HERE = import.meta.dirname;

const SCENARIOS = [
  '1a-one-file-full',
  '1b-subtree-full',
  '1c-whole-src-full',
  '2a-one-file-parse-only',
  '2b-one-file-narrowed',
  '2c-one-file-noresolve',
];

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const rows = [];
for (const s of SCENARIOS) {
  const samples = [];
  for (let i = 0; i < RUNS; i += 1) {
    const argv = [path.join(HERE, 'measure-cold.mjs'), '--scenario', s];
    if (tsRoot) argv.push('--ts', tsRoot);
    samples.push(
      JSON.parse(
        execFileSync(process.execPath, argv, {
          encoding: 'utf8',
        }),
      ),
    );
  }
  const total = samples.map((x) => x.totalMs);
  const work = samples.map((x) => x.workMs);
  const load = samples.map((x) => x.loadMs);
  const rss = samples.map((x) => x.peakRssMb);
  rows.push({
    scenario: s,
    runs: RUNS,
    tsVersion: samples[0].tsVersion,
    rootNames: samples[0].rootNames,
    filesInProgram: samples[0].filesInProgram,
    loadMedianMs: median(load),
    workMedianMs: median(work),
    totalMedianMs: median(total),
    totalMinMs: Math.min(...total),
    totalMaxMs: Math.max(...total),
    peakRssMedianMb: median(rss),
    extractedParams: samples[0].extractedParams,
    extractionError: samples[0].extractionError,
  });
  process.stderr.write(`${s}: ${median(total)} ms median\n`);
}

process.stdout.write(
  JSON.stringify({ node: process.version, rows }, null, 2) + '\n',
);
