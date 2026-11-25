// canary-cry run dir I/O (#608 P3, P4; spec "Codegen and runtime", "Outputs").
// Everything a confirmed run writes or reads back lives here, under
// `runs/<run-id>/` beside the flows file:
//
//   manifest.json          written by the CLI before the executor loads
//   matrix.json            always, even when the run then abstains
//   playwright.config.mjs  specs/<scenario>.spec.mjs   (codegen.mjs)
//   runtime/*.mjs  verdict.mjs   copies, in the same relative layout as
//                          scripts/, so a spec's imports resolve in place
//   observations/<scenario>.json  written by the runtime, one per scenario
//   results/<scenario>.json       each scenario's own Playwright report
//   results.json           those reports merged (canary-test-reporter)
//   checkpoint.json        rewritten after every scenario (checkpoint.mjs)
//   findings.json          canary.cry-findings/1

import fs from 'node:fs';
import path from 'node:path';

import { fileStem, runFiles } from './codegen.mjs';

// The env var the generated config reads for each scenario's report path.
export { RESULTS_ENV } from './codegen.mjs';
import { matrixJson } from './matrix.mjs';

const RUNTIME = new URL('./runtime/', import.meta.url);
const VERDICT = new URL('./verdict.mjs', import.meta.url);

function write(dir, rel, text) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

export const writeMatrix = (dir, matrix) =>
  write(dir, 'matrix.json', `${matrixJson(matrix)}\n`);

/**
 * The generated config and specs, plus the runtime they import.
 * @returns {string} the playwright.config.mjs path
 */
export function writeHarness(dir, manifest, sha) {
  for (const f of runFiles(manifest, sha)) write(dir, f.path, f.text);
  fs.cpSync(RUNTIME, path.join(dir, 'runtime'), { recursive: true });
  fs.copyFileSync(VERDICT, path.join(dir, 'verdict.mjs'));
  return path.join(dir, 'playwright.config.mjs');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** One scenario's files: its spec, its Playwright report, its observation. */
export function scenarioFiles(dir, scenario) {
  const stem = fileStem(scenario.id);
  return {
    spec: path.join(dir, 'specs', `${stem}.spec.mjs`),
    results: path.join(dir, 'results', `${stem}.json`),
    observation: path.join(dir, 'observations', `${stem}.json`),
  };
}

/**
 * One scenario's files, with any report or observation an earlier attempt
 * left removed: a scenario killed mid-run is re-run on resume, and what the
 * killed attempt wrote must never read as the new attempt's outcome.
 */
export function resetScenario(dir, scenario) {
  const files = scenarioFiles(dir, scenario);
  fs.rmSync(files.results, { force: true });
  fs.rmSync(files.observation, { force: true });
  return files;
}

/**
 * What one scenario's Playwright run left behind: whether it wrote its
 * report (no report is a crash), and the observation (null when none).
 */
export function readScenario(dir, scenario) {
  const files = scenarioFiles(dir, scenario);
  return {
    results: fs.existsSync(files.results),
    observation: readJson(files.observation),
  };
}

/** Each scenario's observation by file stem, null when the runtime wrote none. */
export function readObservations(dir, scenarios) {
  return new Map(
    scenarios.map((s) => [
      fileStem(s.id),
      readJson(scenarioFiles(dir, s).observation),
    ]),
  );
}

/** Rewritten after every scenario: a rename, so a kill never tears it. */
export function writeCheckpoint(dir, checkpoint) {
  const file = path.join(dir, 'checkpoint.json');
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(checkpoint, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
}

const COUNTS = ['expected', 'skipped', 'unexpected', 'flaky'];

function mergeStats(reports) {
  const sum = (key) => reports.reduce((n, r) => n + (r.stats?.[key] ?? 0), 0);
  return {
    startTime: reports[0].stats?.startTime,
    duration: sum('duration'),
    ...Object.fromEntries(COUNTS.map((key) => [key, sum(key)])),
  };
}

/**
 * results.json: the scenarios' own reports as one Playwright JSON report, in
 * run order, so canary-test-reporter reads a whole run unchanged. None is
 * written when no scenario reported.
 */
export function mergeResults(dir, scenarios) {
  const reports = scenarios
    .map((s) => readJson(scenarioFiles(dir, s).results))
    .filter((r) => r !== null);
  if (!reports.length) return;
  const doc = {
    ...reports[0],
    suites: reports.flatMap((r) => r.suites ?? []),
    errors: reports.flatMap((r) => r.errors ?? []),
    stats: mergeStats(reports),
  };
  write(dir, 'results.json', `${JSON.stringify(doc, null, 2)}\n`);
}

export const writeFindings = (dir, doc) =>
  write(dir, 'findings.json', `${JSON.stringify(doc, null, 2)}\n`);
