// canary-cry run dirs on the Tier-0 side (#608 P2, P4): the run's argument
// rules, a new `runs/<run-id>/` with its manifest.json, and an existing run
// read back for `run --resume <run-id> --confirm <sha>`. No network and no
// process: this is in the static closure of cli.mjs (SC6), and everything
// here happens before the executor may load.
//
// A resume trusts nothing it reads back. The run's manifest.json supplies
// only the PARAMETERS to rebuild with (target name, amplitude, seed); the
// manifest itself is rebuilt from the input files, and planResume
// (checkpoint.mjs) then binds the rebuild to both --confirm and the sha the
// checkpoint was written for, and refuses a checkpoint it cannot trust.

import fs from 'node:fs';
import path from 'node:path';

import { isRunId, parseMaxWall, planResume } from './checkpoint.mjs';
import { manifestFileText } from './manifest.mjs';

/** `run`'s argument rules: the usage error, or null. */
export function runArgError(opts) {
  if (opts.maxWall !== null) {
    const { error } = parseMaxWall(opts.maxWall);
    if (error !== null) return error;
  }
  if (opts.resume === null) {
    return opts.live === null ? 'run: --live TARGET is required' : null;
  }
  if (opts.live !== null) {
    return 'run --resume takes its target, amplitude and seed from the run; drop --live';
  }
  return opts.confirm === null
    ? 'run --resume needs --confirm SHA, the manifest-sha the run started with'
    : null;
}

const runsDir = (flowsFile) => path.join(path.dirname(flowsFile), 'runs');

/** `20261125T143333Z`: sortable, filesystem-safe, UTC. */
const stamp = (date) =>
  date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

/**
 * A new run dir beside the flows file (.canary/cry/runs/ by default), named
 * `<UTC stamp>-<first 8 of the sha>`, holding the manifest as shown.
 * @returns {{dir: string, file: string}} absolute dir, manifest.json path
 */
export function newRunDir(flowsFile, plan, now) {
  const id = `${stamp(now())}-${plan.sha.slice(0, 8)}`;
  const dir = path.resolve(runsDir(flowsFile), id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'manifest.json');
  fs.writeFileSync(file, manifestFileText(plan.manifest));
  return { dir, file };
}

/** `{found: false}`, or the parsed JSON (`{}` when it does not parse). */
function readBack(file) {
  if (!fs.existsSync(file)) return { found: false, doc: null };
  try {
    return { found: true, doc: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return { found: true, doc: {} };
  }
}

/** What to rebuild with, from the run's manifest.json, or null. */
function paramsOf(doc) {
  const target = doc?.target?.name;
  const { amplitude, seed } = doc ?? {};
  const ok =
    typeof target === 'string' &&
    typeof amplitude === 'string' &&
    Number.isSafeInteger(seed);
  return ok ? { target, amplitude, seed } : null;
}

/**
 * An existing run, for --resume. The id is checked against the run-id shape
 * BEFORE it becomes a path. `checkpoint` is the parsed checkpoint.json (`{}`
 * when it does not parse, so planResume names it damaged).
 * @returns {{error: string} | {error: null, dir: string, checkpoint: object,
 *   params: {target: string, amplitude: string, seed: number}}}
 */
export function readRun(flowsFile, runId) {
  const unknown = { error: `--resume: unknown run-id: ${runId}` };
  if (!isRunId(runId)) return unknown;
  const dir = path.resolve(runsDir(flowsFile), runId);
  const checkpoint = readBack(path.join(dir, 'checkpoint.json'));
  if (!checkpoint.found) return unknown;
  const params = paramsOf(readBack(path.join(dir, 'manifest.json')).doc);
  if (params === null) {
    return { error: `run ${runId}: manifest.json is missing or damaged` };
  }
  return { error: null, dir, checkpoint: checkpoint.doc, params };
}

/**
 * planResume over a rebuilt plan: `{exit: null}` when the run may go on,
 * else `{exit: 2 | 4, reason}`. A rebuild with no manifest (the matrix is
 * empty now) has no sha, so it can never match: exit 4.
 */
export function trustResume({ runId, run, plan, confirm }) {
  return planResume({
    runId,
    checkpoint: run.checkpoint,
    rebuiltSha: plan.sha,
    confirm,
    scenarioIds: (plan.manifest?.scenarios ?? []).map((s) => s.id),
  });
}
