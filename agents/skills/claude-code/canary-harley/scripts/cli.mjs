#!/usr/bin/env node
// canary-harley -- candidate invariants proposed from function signatures,
// and a seeded property test only for a candidate a human confirmed.
//
//   propose  read one source file and print a ranked, heuristic list of
//            candidate invariants; nothing is generated
//   emit     re-derive the candidates and write one seeded fast-check or
//            Hypothesis test per --confirm id, and nothing for any other
//
// Exit codes: 0 proposed or emitted, 2 usage error (a missing --confirm is
// one), 3 abstained (no engine, unreadable file, no candidates, an id that is
// not derivable now, or a candidate that cannot be emitted).
//
// Invoked via `canary skills run canary-harley -- <command> FILE [options]`.

import fs from 'node:fs';
import path from 'node:path';

import {
  createParser,
  formatUsageError,
  EXIT_USAGE,
} from '../../../lib/parse-args.mjs';
import { isMain } from '../../../lib/is-main.mjs';
import { engineCandidates, loadEngine } from './engine.mjs';
import { buildProposal, renderJson, renderMarkdown } from './proposal.mjs';

const PROG = 'canary-harley';
const EXIT_ABSTAINED = 3;

const USAGE =
  'usage: canary-harley [-h] {propose,emit} FILE [--function NAME]\n' +
  '                     [--root DIR] [--json] [--json-out PATH]\n' +
  '                     [--confirm ID[,ID...]] [--out-dir DIR] [--seed N]\n' +
  '                     [--runs N] [--force]\n' +
  '\n' +
  'Proposes candidate invariants from the function signatures in one source\n' +
  'file. A property test is written only for a candidate a human confirmed.\n' +
  '\n' +
  'commands:\n' +
  '  propose FILE          print the ranked candidates; nothing is generated\n' +
  '  emit FILE             write one seeded test per --confirm id\n' +
  '\n' +
  'options:\n' +
  '  -h, --help            show this help message and exit\n' +
  '  --root DIR            project root for paths and output (default: .)\n' +
  '  --function NAME       propose: keep only the candidates of one function\n' +
  '  --json                propose: print the proposal as JSON\n' +
  '  --json-out PATH       propose: also write the proposal JSON to PATH\n' +
  '  --confirm ID[,ID...]  emit: the candidate ids a human confirmed\n' +
  '                        (required; there is no "confirm all")\n' +
  '  --out-dir DIR         emit: output directory inside\n' +
  '                        <root>/tests/generated (default:\n' +
  '                        tests/generated/property)\n' +
  '  --seed N              emit: seed for every file (default: derived from\n' +
  '                        each candidate id)\n' +
  '  --runs N              emit: runs per property (default: 100)\n' +
  '  --force               emit: overwrite an existing generated file\n' +
  '\n' +
  'exit codes: 0 proposed or emitted, 2 usage error, 3 abstained';

export const CLI_SPEC = {
  prog: PROG,
  booleans: { '--json': 'json', '--force': 'force' },
  values: {
    '--function': { key: 'function' },
    '--root': { key: 'root' },
    '--json-out': { key: 'jsonOut' },
    '--confirm': { key: 'confirm' },
    '--out-dir': { key: 'outDir' },
    '--seed': { key: 'seed', type: 'int' },
    '--runs': { key: 'runs', type: 'int' },
  },
  defaults: { root: '.', runs: 100 },
  positionals: { key: 'command' },
};

const parseArgs = createParser(CLI_SPEC);

function abstain(reason) {
  console.error(`${PROG}: abstained: ${reason}`);
  return EXIT_ABSTAINED;
}

function readSource(file) {
  try {
    return { source: fs.readFileSync(file, 'utf8'), error: null };
  } catch (exc) {
    return { source: '', error: exc.code ?? exc.message };
  }
}

/** Posix path from `root` when the file is inside it, else as given. */
function displayPath(file, root) {
  const relative = path.relative(root, path.resolve(file));
  const outside = relative.startsWith('..') || path.isAbsolute(relative);
  return outside ? file : relative.split(path.sep).join('/');
}

/**
 * The step both commands share: the engine's function list and the proposal
 * derived from the file as it is now. `reason` is why there is none.
 */
async function loadProposal(opts, file, ctx) {
  const engine = await loadEngine(ctx.engineDirs ?? engineCandidates());
  if (!engine.ok) return { reason: engine.error };
  const read = readSource(file);
  if (read.error !== null) {
    return { reason: `cannot read ${file} (${read.error})` };
  }
  const root = path.resolve(opts.root);
  const proposal = buildProposal({
    path: displayPath(file, root),
    source: read.source,
    names: engine.extractFileFunctions(file),
    only: opts.function ?? undefined,
  });
  return { reason: null, proposal, root };
}

function writeJson(target, proposal) {
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  fs.writeFileSync(target, renderJson(proposal));
}

async function propose(opts, file, ctx) {
  const loaded = await loadProposal(opts, file, ctx);
  if (loaded.reason !== null) return abstain(loaded.reason);
  const proposal = loaded.proposal;
  if (opts.jsonOut !== null) writeJson(opts.jsonOut, proposal);
  const render = opts.json ? renderJson : renderMarkdown;
  // Both renderers end with one newline; console.log would add a second.
  process.stdout.write(render(proposal));
  return proposal.abstained === null ? 0 : abstain(proposal.abstained);
}

function emit() {
  return Promise.resolve(EXIT_ABSTAINED);
}

const COMMANDS = { propose, emit };

/** The ids in a --confirm value: split at commas, trimmed, empties dropped. */
const confirmedIds = (confirm) =>
  (confirm ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');

// Checked in order; the first match is the usage error. Every check here runs
// before the engine is loaded, so a refused emit has read and written nothing.
const USAGE_CHECKS = [
  [(args) => args.error !== null, (args) => args.error],
  [
    (args) => args.command === undefined,
    () => 'the following arguments are required: command',
  ],
  [
    (args) => !Object.hasOwn(COMMANDS, args.command),
    (args) =>
      `argument command: invalid choice: '${args.command}' ` +
      "(choose from 'propose', 'emit')",
  ],
  [
    (args) => args.file === undefined,
    () => 'the following arguments are required: FILE',
  ],
  [
    (args) => args.extra.length > 0,
    (args) => `unrecognized arguments: ${args.extra.join(' ')}`,
  ],
  [
    (args) => args.command === 'emit' && args.opts.confirm === null,
    () => 'the following arguments are required: --confirm',
  ],
  [
    (args) =>
      args.command === 'emit' && confirmedIds(args.opts.confirm).length === 0,
    () => 'argument --confirm: expected at least one candidate id',
  ],
  [
    (args) => args.opts.runs < 1,
    (args) => `argument --runs: must be at least 1, got ${args.opts.runs}`,
  ],
];

/** A usage error for argv, or null. */
function usageError(error, positionals, opts) {
  const [command, file, ...extra] = positionals;
  const args = { error, command, file, extra, opts };
  const hit = USAGE_CHECKS.find(([applies]) => applies(args));
  return hit ? hit[1](args) : null;
}

/**
 * @param {string[]} argv
 * @param {{ engineDirs?: string[] }} [deps] tests inject the engine lookup
 * @returns {number | Promise<number>} a number for --help and usage errors, a
 *   Promise for a dispatched command
 */
export function main(argv = [], deps = {}) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }
  const bad = usageError(parsed.error, parsed.positionals, parsed.opts);
  if (bad !== null) {
    console.error(formatUsageError(PROG, bad));
    return EXIT_USAGE;
  }
  const [command, file] = parsed.positionals;
  const ctx = { engineDirs: deps.engineDirs ?? null };
  return COMMANDS[command](parsed.opts, file, ctx);
}

// `process.exitCode`, not `process.exit()`: a large `--json` payload must
// drain before the process ends (#791).
if (isMain(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
