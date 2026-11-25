#!/usr/bin/env node
// canary-cry -- pre-launch "try to break it" sweep of ordinary user flows.
//
// P1 shipped the Tier-0 half (deterministic, no network, no agent), P2 the
// live gate, P3 the executor behind it (execute.mjs, lazily imported).
//
//   validate  check .canary/cry/flows.json and targets.json; every error names
//             the JSON path at fault
//   matrix    the ranked scenario matrix: flows x the abuse-pattern catalog,
//             cut to an --amplitude budget; same input, byte-identical --json
//   run       --live <t>: gate, print the manifest + sha; --confirm runs it
//
// `report` exits 2 "not yet supported" until its phase. Exit codes: 0 ok
// (advisory), 2 usage or input error, 3 --strict and abstained, 1 --strict
// and >= 1 corrupted, 4 refused by a safety gate (ADR 0046), and 1 an
// unexpected exception (issue 1716).
//
// Invoked via `canary skills run canary-cry -- <command> [options]`.

import fs from 'node:fs';
import path from 'node:path';

import {
  createParser,
  formatUsageError,
  EXIT_USAGE,
} from '../../../lib/parse-args.mjs';
import { isMain } from '../../../lib/is-main.mjs';
import { validateCriticalAreas } from '../../../lib/contracts/critical-areas.mjs';
import { gateLive } from './gate.mjs';
import { manifestFileText, planRun } from './manifest.mjs';
import { AMPLITUDES, buildMatrix, matrixJson } from './matrix.mjs';
import {
  renderManifest,
  renderMatrix,
  renderRunAbstained,
  USAGE,
} from './render.mjs';
import { readJsonFile } from './schema-core.mjs';
import { loadFlows, loadTargets } from './schema.mjs';

const PROG = 'canary-cry';
const EXIT_ABSTAINED = 3;
const EXIT_REFUSED = 4;
const LATER_PHASE = '(a later phase of #608)';
/** The amplitudes `run` can execute today; `matrix` knows all three. */
const RUNNABLE = new Set(['whisper']);

const DEFAULT_AREAS = '.canary/critical-areas.json';
const LATER = new Set(['report']);

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
};

/** A usage error for argv, or null. */
function usageError(error, positionals) {
  if (error) return error;
  const [command, ...extra] = positionals;
  if (command === undefined) {
    return 'the following arguments are required: command';
  }
  if (LATER.has(command)) {
    return `'${command}' is not yet supported ${LATER_PHASE}`;
  }
  if (!Object.hasOwn(COMMANDS, command)) {
    return `argument command: invalid choice: '${command}' (choose from 'validate', 'matrix', 'run')`;
  }
  if (extra.length) return `unrecognized arguments: ${extra.join(' ')}`;
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

function amplitudeError(amplitude) {
  if (Object.hasOwn(AMPLITUDES, amplitude)) return null;
  const choices = Object.keys(AMPLITUDES).map((a) => `'${a}'`);
  return (
    `argument --amplitude: invalid choice: '${amplitude}' ` +
    `(choose from ${choices.join(', ')})`
  );
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

// --- run --live: the two-step gate of ADR 0046 -------------------------------
// Order is load-bearing: inputs (exit 2); the target gate (exit 4) before any
// credential is read; the account env vars (exit 2); then the run dir. With
// --confirm the manifest is REBUILT from the files, never read back from the
// run dir; only a matching sha loads the executor, by a lazy import: SC6.

function refused(reason) {
  console.error(`${PROG}: refused: ${reason}`);
  return EXIT_REFUSED;
}

/** `20261125T143333Z`: sortable, filesystem-safe, UTC. */
const stamp = (date) =>
  date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

function runArgError(opts) {
  if (opts.live === null) return 'run: --live TARGET is required';
  if (RUNNABLE.has(opts.amplitude)) return null;
  return `run --amplitude ${opts.amplitude} is not yet supported ${LATER_PHASE}; matrix accepts it`;
}

/** The run dir sits beside the flows file: .canary/cry/runs/ by default. */
function writeRunDir(flowsFile, plan, now) {
  const id = `${stamp(now())}-${plan.sha.slice(0, 8)}`;
  const dir = path.join(path.dirname(flowsFile), 'runs', id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'manifest.json');
  fs.writeFileSync(file, manifestFileText(plan.manifest));
  return file;
}

function confirmRun(opts, plan, ctx) {
  if (opts.confirm !== plan.sha) {
    return refused(
      `manifest-sha mismatch: confirmed ${opts.confirm}, rebuilt ${plan.sha}. ` +
        'Re-run without --confirm and read the new manifest.',
    );
  }
  const dir = path.resolve(
    path.dirname(writeRunDir(opts.flows, plan, ctx.now)),
  );
  const run = (m) => m.executeRun({ ...ctx, opts, plan, dir });
  return import('./execute.mjs').then(run);
}

function runCommand(opts, ctx) {
  const bad = runArgError(opts);
  if (bad !== null) return fail([bad]);
  const flows = loadFlows(opts.flows);
  if (flows.errors.length) return fail(flows.errors);
  const targets = loadTargets(opts.targets, flowIds(flows.doc));
  if (targets.errors.length) return fail(targets.errors);
  const gate = gateLive(targets.doc, opts.live, ctx.env);
  if (gate.refusal !== null) return refused(gate.refusal);
  if (gate.errors.length) return fail(gate.errors);
  const { amplitude, seed } = opts;
  const plan = planRun({
    flowsDoc: flows.doc,
    target: gate.target,
    amplitude,
    seed,
  });
  if (plan.manifest === null) {
    const declared = flows.doc.flows.length;
    console.log(renderRunAbstained(plan.matrix, opts.live, declared));
    return opts.strict ? EXIT_ABSTAINED : 0;
  }
  if (opts.confirm !== null) return confirmRun(opts, plan, ctx);
  const file = writeRunDir(opts.flows, plan, ctx.now);
  console.log(renderManifest(plan.manifest, plan.sha, file));
  return 0;
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
    return COMMANDS[positionals[0]](opts, ctx);
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
