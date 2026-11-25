#!/usr/bin/env node
// canary-cry -- pre-launch "try to break it" sweep of ordinary user flows.
//
// Phase 1 (#608 P1) ships the Tier-0 half: deterministic, no network, no agent.
//
//   validate  check .canary/cry/flows.json and targets.json; every error names
//             the JSON path at fault
//   matrix    the ranked scenario matrix: flows x the abuse-pattern catalog,
//             cut to an --amplitude budget; same input, byte-identical --json
//
// `run` and `report` arrive in later phases and exit 2 "not yet supported"
// until then, rather than doing something smaller under the same name.
//
// Exit codes: 0 ok (advisory), 2 usage or schema error, 3 --strict and the
// matrix abstained (zero scenarios). 1 and 4 (ADR 0046: refused by a safety
// gate) belong to `run`.
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
import { readJsonFile } from './schema-core.mjs';
import { loadFlows, loadTargets } from './schema.mjs';
import { AMPLITUDES, buildMatrix, matrixJson } from './matrix.mjs';

const PROG = 'canary-cry';
const EXIT_ABSTAINED = 3;

// #508 convention line, written as escapes so this source stays ASCII (the
// same wording as ts/src/core/gate-result.ts and the other skill CLIs).
const ABSTAINED_LINE =
  '\u{26A0} Abstained \u{2014} verified zero items; this is not a pass.';

const DEFAULT_AREAS = '.canary/critical-areas.json';
const LATER = new Set(['run', 'report']);

const USAGE =
  'usage: canary-cry [-h] {validate,matrix} [--flows PATH] [--targets PATH]\n' +
  '                  [--target NAME] [--critical-areas PATH]\n' +
  '                  [--amplitude {whisper,shout,scream}] [--seed N]\n' +
  '                  [--json] [--strict]\n' +
  '\n' +
  'Pre-launch "try to break it" sweep of ordinary user flows. This phase ships\n' +
  'the deterministic scenario matrix: no network, no agent.\n' +
  '\n' +
  'commands:\n' +
  '  validate              check flows.json and targets.json\n' +
  '  matrix                rank flows x abuse patterns, cut to a budget\n' +
  '\n' +
  'options:\n' +
  '  -h, --help            show this help message and exit\n' +
  '  --flows PATH          flows file (default: .canary/cry/flows.json)\n' +
  '  --targets PATH        targets file (default: .canary/cry/targets.json)\n' +
  '  --target NAME         matrix: also schedule the target-scoped patterns\n' +
  '  --critical-areas PATH matrix: rank with critical areas (default:\n' +
  '                        .canary/critical-areas.json, when present)\n' +
  '  --amplitude A         matrix budget: whisper (default), shout, scream\n' +
  '  --seed N              recorded for {{unique.*}} test data; never selects\n' +
  '                        scenarios (default: 0)\n' +
  '  --json                matrix: print the canonical matrix.json document\n' +
  '  --strict              matrix: exit 3 when the matrix abstained';

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

const COMMANDS = { validate: validateCommand, matrix: matrixCommand };

/** A usage error for argv, or null. */
function usageError(error, positionals) {
  if (error) return error;
  const [command, ...extra] = positionals;
  if (command === undefined) {
    return 'the following arguments are required: command';
  }
  if (LATER.has(command)) {
    return `'${command}' is not yet supported (a later phase of #608)`;
  }
  if (!Object.hasOwn(COMMANDS, command)) {
    return `argument command: invalid choice: '${command}' (choose from 'validate', 'matrix')`;
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

/** One line per distinct reason, in first-seen (catalog) order. */
function unscheduledLines(unscheduled) {
  const byReason = new Map();
  for (const u of unscheduled) {
    byReason.set(u.reason, [...(byReason.get(u.reason) ?? []), u.pattern]);
  }
  return [...byReason].map(
    ([reason, names]) =>
      `target-scoped patterns not scheduled (${reason}): ${names.join(', ')}`,
  );
}

function renderMatrix(m) {
  const where = m.target === null ? '' : `, target ${m.target}`;
  const lines = [
    `${PROG} matrix -- amplitude ${m.amplitude}, seed ${m.seed}, ` +
      `ranking: ${m.ranking}${where}`,
  ];
  if (m.status === 'abstained') {
    lines.push(
      `ABSTAINED: zero scenarios -- no scheduled pattern ` +
        `(${m.patterns.join(', ')}) applies to any declared step.`,
    );
    lines.push(ABSTAINED_LINE);
  } else {
    const rounds = m.intensities.map((n) => `i${n}`).join(', ');
    lines.push(
      `${m.scenarios.length} scenario(s) over ${m.flows.length} flow(s); ` +
        `patterns: ${m.patterns.join(', ')}; intensity: ${rounds}`,
    );
    for (const s of m.scenarios) {
      lines.push(`  ${String(s.score).padStart(3)}  ${s.id}`);
    }
  }
  lines.push(...unscheduledLines(m.unscheduled));
  return lines.join('\n');
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
  console.log(opts.json ? matrixJson(matrix) : renderMatrix(matrix));
  return matrix.status === 'abstained' && opts.strict ? EXIT_ABSTAINED : 0;
}

/** @param {string[]} argv */
export function main(argv = []) {
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
    return COMMANDS[positionals[0]](opts);
  } catch (exc) {
    console.error(`${PROG}: ${exc.message}`);
    return 1;
  }
}

// `process.exitCode`, not `process.exit()`: a large `--json` payload must
// drain before the process ends (#791).
if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
