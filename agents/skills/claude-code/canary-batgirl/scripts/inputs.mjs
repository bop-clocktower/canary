// inputs -- resolve each flag to a bounded, contained read (spec D5, D7).
// Split from cli.mjs so the entry point stays within the perf coupling rule
// (at most five imports).
//
// Four inputs have the conventional path their producer writes; two
// (batwoman, cassandra) have no on-disk convention and are read only when
// named. A DEFAULT path that is absent is a not-assessed dimension. A NAMED
// path that is absent, or any path that cannot be read as the expected kind,
// is an I/O error the CLI exits 1 on. Everything else -- a symlink, an input
// over a limit, a file that does not parse -- becomes the dimension's reason.

import { readJson, readJsonFiles, readText } from './read.mjs';

/** One row per dimension: its flag, default path and reader. */
const INPUTS = Object.freeze([
  {
    id: 'escaped-defects',
    flag: '--escapes',
    key: 'escapes',
    fallback: '.canary/escapes.json',
    reader: 'json',
  },
  {
    id: 'coverage-verified-share',
    flag: '--guardian',
    key: 'guardian',
    fallback: '.harness/analyses',
    reader: 'files',
    prefix: 'canary-pr-guardian-',
  },
  {
    id: 'closure-exercise',
    flag: '--batwoman',
    key: 'batwoman',
    fallback: null,
    reader: 'files',
    prefix: '',
    noun: 'batwoman report',
  },
  {
    id: 'unexplained-switch-offs',
    flag: '--ledger',
    key: 'ledger',
    fallback: '.canary/quarantine.json',
    reader: 'json',
  },
  {
    id: 'vacuous-tests',
    flag: '--cassandra',
    key: 'cassandra',
    fallback: null,
    reader: 'json',
    noun: 'canary-cassandra --json report',
  },
  {
    id: 'red-mainline-commits',
    flag: '--history',
    key: 'history',
    fallback: 'test-results/reports/history-v2.jsonl',
    reader: 'text',
  },
]);

function readOne(row, source, ctx) {
  if (row.reader === 'text') return readText(source, ctx);
  if (row.reader === 'json') return readJson(source, ctx);
  return readJsonFiles(source, row.prefix, ctx);
}

/** The input for one row, or the I/O error message for it. */
function resolve(row, named, ctx) {
  const source = named ?? row.fallback;
  if (source === null) {
    const reason = `no ${row.noun} named (${row.flag} PATH)`;
    return { input: { source: null, read: { kind: 'absent', reason } } };
  }
  const read = readOne(row, source, ctx);
  if (read.kind === 'missing' && named !== null) {
    return { error: `${row.flag} ${source}: no such file` };
  }
  if (read.kind === 'unreadable') {
    return { error: `${row.flag} ${source}: ${read.reason}` };
  }
  return { input: { source, read } };
}

/**
 * Read every input, or return the message naming the one that failed.
 *
 * @param {Record<string, string|null>} args parsed flags
 * @param {{root?: string, limits?: object}} [ctx]
 * @returns {{inputs: Record<string, object>} | {error: string}}
 */
export function gather(args, ctx = {}) {
  const inputs = {};
  for (const row of INPUTS) {
    const { input, error } = resolve(row, args[row.key] ?? null, ctx);
    if (error) return { error };
    inputs[row.id] = input;
  }
  return { inputs };
}
