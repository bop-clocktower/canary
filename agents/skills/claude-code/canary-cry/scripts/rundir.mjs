// canary-cry run dir I/O (#608 P3; spec "Codegen and runtime", "Outputs").
// Everything a confirmed run writes or reads back lives here, under
// `runs/<run-id>/` beside the flows file:
//
//   manifest.json          written by cli.mjs before the executor loads
//   matrix.json            always, even when the run then abstains
//   playwright.config.mjs  specs/<scenario>.spec.mjs   (codegen.mjs)
//   runtime/*.mjs  verdict.mjs   copies, in the same relative layout as
//                          scripts/, so a spec's imports resolve in place
//   observations/<scenario>.json  written by the runtime, one per scenario
//   results.json           Playwright's JSON reporter (canary-test-reporter)
//   findings.json          canary.cry-findings/1

import fs from 'node:fs';
import path from 'node:path';

import { fileStem, runFiles } from './codegen.mjs';
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

/**
 * What the browser run left behind: whether Playwright wrote its results,
 * and each scenario's observation (null when the runtime wrote none).
 * @param {string} dir
 * @param {{id: string}[]} scenarios keyed by their file stem
 */
export function readOutcome(dir, scenarios) {
  const stems = scenarios.map((s) => fileStem(s.id));
  const results = fs.existsSync(path.join(dir, 'results.json'));
  const observations = new Map(
    stems.map((stem) => [
      stem,
      readJson(path.join(dir, 'observations', `${stem}.json`)),
    ]),
  );
  return { results, observations };
}

export const writeFindings = (dir, doc) =>
  write(dir, 'findings.json', `${JSON.stringify(doc, null, 2)}\n`);
