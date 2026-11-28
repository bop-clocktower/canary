// ledger -- the append-only outcome-label store (#618).
//
// One NDJSON file, one record per line, three kinds: `finding` (a gate finding
// and its line-free id), `run` (one recorded gate run and which findings it
// held) and `label` (an outcome with its provenance). The tool only appends.
// A malformed or unknown line is counted as not read and left exactly as it
// is: repairing it would rewrite history a person may need to audit.
//
// When labels for one finding disagree, the latest line wins -- that is how a
// human overrides a derived label without erasing it.

import { appendInside, readInside } from './files.mjs';

const SCHEMA_VERSION = 1;

/** A ledger past this size is reported as not read, never read in part. */
const MAX_LEDGER_BYTES = 20 * 1024 * 1024;

const KINDS = new Set(['finding', 'run', 'label']);

function emptyState() {
  return { findings: new Map(), runs: [], labels: [] };
}

/** One line as a record, or null when it is not one this version knows. */
function parseLine(line) {
  try {
    const rec = JSON.parse(line);
    const known =
      rec && rec.v === SCHEMA_VERSION && KINDS.has(rec.kind) && rec.gate;
    return known ? rec : null;
  } catch {
    return null;
  }
}

function addRecord(state, rec) {
  if (rec.kind === 'finding') {
    if (!state.findings.has(rec.id)) state.findings.set(rec.id, rec);
  } else if (rec.kind === 'run') state.runs.push(rec);
  else state.labels.push(rec);
}

/**
 * @param {string} root
 * @param {string} rel
 * @returns {{state: object, malformed: number, missing: boolean,
 *            endsClean: boolean, notRead?: string}}
 */
export function loadLedger(root, rel) {
  const read = readInside(root, rel, {
    ext: '.jsonl',
    maxBytes: MAX_LEDGER_BYTES,
  });
  const state = emptyState();
  const base = { state, malformed: 0, endsClean: true };
  if (read.notRead === 'missing') return { ...base, missing: true };
  if (read.notRead) return { ...base, missing: false, notRead: read.notRead };
  let malformed = 0;
  for (const line of read.text.split('\n')) {
    if (line.trim() === '') continue;
    const rec = parseLine(line);
    if (rec) addRecord(state, rec);
    else malformed += 1;
  }
  const endsClean = read.text === '' || read.text.endsWith('\n');
  return { state, malformed, missing: false, endsClean };
}

/**
 * Append `records`, one JSON line each. `endsClean` false means the file's
 * last line has no newline, so one is written first rather than gluing a new
 * record onto it.
 *
 * @returns {string|null} null on success, else a short reason
 */
export function appendRecords(root, rel, records, endsClean) {
  if (records.length === 0) return null;
  const body = records.map((r) => JSON.stringify(r)).join('\n');
  return appendInside(root, rel, `${endsClean ? '' : '\n'}${body}\n`);
}
