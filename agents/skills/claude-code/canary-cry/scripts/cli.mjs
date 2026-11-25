#!/usr/bin/env node
// canary-cry -- pre-launch "try to break it" sweep of ordinary user flows.
//
// P1 shipped the Tier-0 half (deterministic, no network, no agent), P2 the
// live gate, P3 the executor behind it (execute.mjs, lazily imported), P4
// its rounds, convergence, --max-wall, checkpoints and --resume, P5 report.
//
//   validate  check .canary/cry/flows.json and targets.json; every error names
//             the JSON path at fault
//   matrix    the ranked scenario matrix: flows x the abuse-pattern catalog,
//             cut to an --amplitude budget; same input, byte-identical --json
//   run       --live <t>: gate, print the manifest + sha; --confirm runs it;
//             --resume <run-id> --confirm <sha> picks a stopped run back up
//   report    <run-id>: findings.json ranked into report.md, with replays
//
// Exit codes: 0 ok (advisory), 2 usage or input error, 3 --strict and
// abstained or PARTIAL, 1 --strict and >= 1 corrupted, 4 refused by a safety
// gate (ADR 0046), and 1 an unexpected exception (issue 1716).
//
// Invoked via `canary skills run canary-cry -- <command> [options]`.

import fs from 'node:fs';

import {
  createParser,
  formatUsageError,
  EXIT_USAGE,
} from '../../../lib/parse-args.mjs';
import { isMain } from '../../../lib/is-main.mjs';
import { validateCriticalAreas } from '../../../lib/contracts/critical-areas.mjs';
import { gateLive } from './gate.mjs';
import { planRun } from './manifest.mjs';
import { amplitudeError, buildMatrix, matrixJson } from './matrix.mjs';
import {
  renderManifest,
  renderMatrix,
  renderRunAbstained,
  USAGE,
} from './render.mjs';
import { newRunDir, readRun, runArgError, trustResume } from './runs.mjs';
import { runReport } from './report.mjs';
import { readJsonFile } from './schema-core.mjs';
import { loadFlows, loadTargets } from './schema.mjs';

const PROG = 'canary-cry';
const EXIT_ABSTAINED = 3;
const EXIT_REFUSED = 4;

const DEFAULT_AREAS = '.canary/critical-areas.json';

export const CLI_SPEC = {
  prog: PROG,
  booleans: { '--json': 'json', '--strict': 'strict' },
  values: {
    '--flows': { key: 'flows' },
    '--targets': { key: 'targets' },
    '--target': { key: 'target' },
    '--critical-areas': { key: 'criticalAreas' },
    '--amplitude': { key: 'amplitude' },
    '--seed': { key: 'seed', type: 'int' },
    '--live': { key: 'live' },
    '--confirm': { key: 'confirm' },
    '--max-wall': { key: 'maxWall' },
    '--resume': { key: 'resume' },
  },
  defaults: {
    flows: '.canary/cry/flows.json',
    targets: '.canary/cry/targets.json',
    amplitude: 'whisper',
    seed: 0,
  },
  positionals: { key: 'command' },
};

const parseArgs = createParser(CLI_SPEC);

const COMMANDS = {
  validate: validateCommand,
  matrix: matrixCommand,
  run: runCommand,
  report: reportCommand,
};

/** A usage error for argv, or null. */
function usageError(error, positionals) {
  if (error) return error;
  const [command, ...extra] = positionals;
  if (command === undefined) {
    return 'the following arguments are required: command';
  }
  if (!Object.hasOwn(COMMANDS, command)) {
    return `argument command: invalid choice: '${command}' (choose from 'validate', 'matrix', 'run', 'report')`;
  }
  const over = extra.slice(command === 'report' ? 1 : 0); // its run-id
  if (over.length) return `unrecognized arguments: ${over.join(' ')}`;
  return null;
}

function fail(lines) {
  for (const line of lines) console.error(formatUsageError(PROG, line));
  return EXIT_USAGE;
}

const flowIds = (doc) => new Set(doc.flows.map((f) => f.id));
const targetNames = (doc) => Object.keys(doc.targets).filter((k) => k !== '//');

function validateCommand(opts) {
  const flows = loadFlows(opts.flows);
  if (flows.errors.length) return fail(flows.errors);
  const targets = loadTargets(opts.targets, flowIds(flows.doc));
  if (targets.errors.length) return fail(targets.errors);
  const nFlows = flows.doc.flows.length;
  const nTargets = targetNames(targets.doc).length;
  console.log(
    `${PROG}: valid -- ${nFlows} flow(s) in ${opts.flows}, ` +
      `${nTargets} target(s) in ${opts.targets}`,
  );
  return 0;
}

/** `{value: {name, spec} | null, errors}`; targets.json is read only for --target. */
function resolveTarget(opts, flowsDoc) {
  if (opts.target === null) return { value: null, errors: [] };
  const targets = loadTargets(opts.targets, flowIds(flowsDoc));
  if (targets.errors.length) return { value: null, errors: targets.errors };
  const names = targetNames(targets.doc);
  if (!names.includes(opts.target)) {
    const known = names.join(', ');
    const error = `${opts.targets}: no target named '${opts.target}' (declared: ${known})`;
    return { value: null, errors: [error] };
  }
  const spec = targets.doc.targets[opts.target];
  return { value: { name: opts.target, spec }, errors: [] };
}

/**
 * critical-areas.json. The default path may be absent: the ranking then stays
 * `declared` and says so. A path given with --critical-areas must exist, and a
 * file that is present but malformed is an input error either way -- a
 * ranking boost is never guessed from a file that does not validate.
 */
function loadAreas(explicit) {
  const file = explicit ?? DEFAULT_AREAS;
  if (explicit === null && !fs.existsSync(file)) {
    return { value: null, errors: [] };
  }
  const read = readJsonFile(file, 'critical-areas');
  if (read.error !== undefined) return { value: null, errors: [read.error] };
  const { errors } = validateCriticalAreas(read.doc);
  if (errors.length) {
    const lines = errors.map((e) => `${file}: ${e.path}: ${e.message}`);
    return { value: null, errors: lines };
  }
  return { value: read.doc.areas, errors: [] };
}

function matrixCommand(opts) {
  const bad = amplitudeError(opts.amplitude);
  if (bad !== null) return fail([bad]);
  const flows = loadFlows(opts.flows);
  if (flows.errors.length) return fail(flows.errors);
  const target = resolveTarget(opts, flows.doc);
  if (target.errors.length) return fail(target.errors);
  const areas = loadAreas(opts.criticalAreas);
  if (areas.errors.length) return fail(areas.errors);
  const matrix = buildMatrix({
    flows: flows.doc.flows,
    amplitude: opts.amplitude,
    seed: opts.seed,
    target: target.value,
    areas: areas.value,
  });
  const text = opts.json
    ? matrixJson(matrix)
    : renderMatrix(matrix, flows.doc.flows.length);
  console.log(text);
  return matrix.status === 'abstained' && opts.strict ? EXIT_ABSTAINED : 0;
}

// --- run: the two-step gate of ADR 0046 ------------------------------------
// Order is load-bearing: inputs (exit 2); the target gate (exit 4) before any
// credential is read; the account env vars (exit 2); then the run dir. With
// --confirm the manifest is REBUILT from the files, never read back from the
// run dir; only a matching sha loads the executor, by a lazy import: SC6.
// --resume rebuilds it the same way, from the parameters its run recorded.

function refused(reason) {
  console.error(`${PROG}: refused: ${reason}`);
  return EXIT_REFUSED;
}

/** The gated plan rebuilt from the files, or `{exit}` when a check stopped. */
function gatedPlan(opts, ctx, { target, amplitude, seed }) {
  const flows = loadFlows(opts.flows);
  if (flows.errors.length) return { exit: fail(flows.errors) };
  const targets = loadTargets(opts.targets, flowIds(flows.doc));
  if (targets.errors.length) return { exit: fail(targets.errors) };
  const gate = gateLive(targets.doc, target, ctx.env);
  if (gate.refusal !== null) return { exit: refused(gate.refusal) };
  if (gate.errors.length) return { exit: fail(gate.errors) };
  const flowsDoc = flows.doc;
  const plan = planRun({ flowsDoc, target: gate.target, amplitude, seed });
  return { plan, declared: flowsDoc.flows.length };
}

/** The ONE way the executor loads: lazily, after the sha check passed. */
const execute = (ctx, input) =>
  import('./execute.mjs').then((m) => m.executeRun({ ...ctx, ...input }));

function liveCommand(opts, ctx) {
  const { amplitude, seed } = opts;
  const live = gatedPlan(opts, ctx, { target: opts.live, amplitude, seed });
  if (live.exit !== undefined) return live.exit;
  const { plan } = live;
  if (plan.manifest === null) {
    console.log(renderRunAbstained(plan.matrix, opts.live, live.declared));
    return opts.strict ? EXIT_ABSTAINED : 0;
  }
  if (opts.confirm === null) {
    const { file } = newRunDir(opts.flows, plan, ctx.now);
    console.log(renderManifest(plan.manifest, plan.sha, file));
    return 0;
  }
  if (opts.confirm !== plan.sha) {
    return refused(
      `manifest-sha mismatch: confirmed ${opts.confirm}, rebuilt ${plan.sha}. ` +
        'Re-run without --confirm and read the new manifest.',
    );
  }
  const { dir } = newRunDir(opts.flows, plan, ctx.now);
  return execute(ctx, { opts, plan, dir });
}

/** `run --resume <run-id> --confirm <sha>`: exit 2 usage, exit 4 refusal. */
function resumeCommand(opts, ctx) {
  const runId = opts.resume;
  const run = readRun(opts.flows, runId);
  if (run.error !== null) return fail([run.error]);
  const bad = amplitudeError(run.params.amplitude);
  if (bad !== null) return fail([`run ${runId}: manifest.json: ${bad}`]);
  const live = gatedPlan(opts, ctx, run.params);
  if (live.exit !== undefined) return live.exit;
  const { plan } = live;
  const trust = trustResume({ runId, run, plan, confirm: opts.confirm });
  if (trust.exit === EXIT_REFUSED) return refused(trust.reason);
  if (trust.exit !== null) return fail([trust.reason]);
  return execute(ctx, { opts, plan, dir: run.dir, resume: run.checkpoint });
}

function reportCommand(opts, _ctx, [runId]) {
  const r = runReport(opts, runId);
  if (r.errors !== null) return fail(r.errors);
  console.log(r.text);
  return r.exit;
}

function runCommand(opts, ctx) {
  const live = opts.resume === null;
  const bad =
    runArgError(opts) ?? (live ? amplitudeError(opts.amplitude) : null);
  if (bad !== null) return fail([bad]);
  return live ? liveCommand(opts, ctx) : resumeCommand(opts, ctx);
}

/**
 * @param {string[]} argv
 * @param {{env?: Record<string, string | undefined>, now?: () => Date,
 *   pw?: object}} [deps] tests inject the env, the clock and Playwright
 * @returns {number | Promise<number>} a Promise only for a confirmed run
 */
export function main(argv = [], deps = {}) {
  const ctx = {
    ...deps,
    env: deps.env ?? process.env,
    now: deps.now ?? (() => new Date()),
  };
  const { opts, positionals, help, error } = parseArgs(argv);
  if (help) {
    console.log(USAGE);
    return 0;
  }
  const bad = usageError(error, positionals);
  if (bad) {
    console.error(formatUsageError(PROG, bad));
    return EXIT_USAGE;
  }
  try {
    return COMMANDS[positionals[0]](opts, ctx, positionals.slice(1));
  } catch (exc) {
    console.error(`${PROG}: ${exc.message}`);
    return 1;
  }
}

// `process.exitCode`, not `process.exit()`: a large `--json` payload must
// drain before the process ends (#791).
if (isMain(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
