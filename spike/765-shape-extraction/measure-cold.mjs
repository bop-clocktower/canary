/**
 * Throwaway spike harness for #765 D2 -- question 1 and 2. NOT engine code.
 *
 * One process = one measurement, so the numbers are genuinely cold: a second
 * `createProgram` in the same process reuses a warm module graph and a warm
 * JIT and reads roughly 5x faster, which would flatter the result.
 *
 *   node measure-cold.mjs --scenario <name> [--ts <root>] --json
 *
 * The parent driver (run-cold.mjs) spawns this N times and takes medians.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  CONFIGS,
  REPO_TS,
  buildProgram,
  functionShapes,
  functionSyntaxOnly,
  loadTs,
  parseOnly,
} from './lib.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};

const SRC = path.join(REPO_TS, 'src');
const ONE_FILE = path.join(SRC, 'core', 'gate-result.ts');
const SUBTREE = path.join(SRC, 'core');

function tsFilesIn(dir) {
  return fs
    .readdirSync(dir, { recursive: true })
    .map((f) => path.join(dir, String(f)))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
}

/**
 * Scenarios. Each returns { files, cfg } or a custom `run`.
 *
 * 1a/1b/1c are question 1 (cold cost of a full program at three scopes).
 * 2a/2b/2c are question 2 (the cheaper alternatives, same target as 1a).
 */
const SCENARIOS = {
  '1a-one-file-full': () => ({ files: [ONE_FILE], cfg: CONFIGS.full }),
  '1b-subtree-full': () => ({ files: tsFilesIn(SUBTREE), cfg: CONFIGS.full }),
  '1c-whole-src-full': () => ({ files: tsFilesIn(SRC), cfg: CONFIGS.full }),
  '2a-one-file-parse-only': () => ({ parseOnly: true, file: ONE_FILE }),
  '2b-one-file-narrowed': () => ({ files: [ONE_FILE], cfg: CONFIGS.narrowed }),
  '2c-one-file-noresolve': () => ({
    files: [ONE_FILE],
    cfg: CONFIGS.noresolve,
  }),
};

const name = opt('scenario');
if (!SCENARIOS[name]) {
  process.stderr.write(`unknown scenario: ${name}\n`);
  process.stderr.write(`known: ${Object.keys(SCENARIOS).join(', ')}\n`);
  process.exit(2);
}

const tsRoot = opt('ts', undefined);
const t0 = performance.now();
const { ts, version } = await loadTs(tsRoot);
const tLoaded = performance.now();

const plan = SCENARIOS[name]();
let filesInProgram = 0;
let extraction = null;

if (plan.parseOnly) {
  const text = fs.readFileSync(plan.file, 'utf8');
  const sf = parseOnly(ts, plan.file, text);
  filesInProgram = 1;
  extraction = functionSyntaxOnly(ts, sf, 'gateOutcome');
} else {
  const program = buildProgram(ts, plan.files, plan.cfg);
  // Force the checker to actually do work: a Program is lazy, so timing
  // createProgram alone understates the real cost of a shape query.
  filesInProgram = program.getSourceFiles().length;
  extraction = functionShapes(ts, program, ONE_FILE, 'gateOutcome');
}

const tDone = performance.now();
const ru = process.resourceUsage();

process.stdout.write(
  JSON.stringify({
    scenario: name,
    tsVersion: version,
    node: process.version,
    rootNames: plan.parseOnly ? 1 : plan.files.length,
    filesInProgram,
    loadMs: +(tLoaded - t0).toFixed(1),
    workMs: +(tDone - tLoaded).toFixed(1),
    totalMs: +(tDone - t0).toFixed(1),
    // maxRSS is reported in kilobytes by libuv on macOS and Linux.
    peakRssMb: +(ru.maxRSS / 1024).toFixed(1),
    extractedParams: extraction.params?.length ?? null,
    extractionError: extraction.error ?? null,
  }) + '\n',
);
