// sources -- the only module in canary-signal that reads the filesystem.
//
// Two persisted records of "what testing did": the run-history store
// (history-v2.jsonl, one RunRecord per line -- ts/src/history/record.ts) and
// the katana quarantine ledger ({schema_version, entries: [...]}).
//
// The two are NOT treated alike when absent, on purpose (spec D10). --history
// is required, so a missing store is an error: returning [] would be
// byte-identical to an empty store and print an abstention, a plausible wrong
// answer to a typo. The ledger is optional: its DEFAULT path missing is a dark
// source the digest names, but a path the caller typed that is missing is a
// typo and must look like one.

import fs from 'node:fs';

/** Where canary-katana writes its ledger, relative to the working directory. */
export const DEFAULT_LEDGER = '.canary/quarantine.json';

const isPlainObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Store versions this reader understands. Mirrors SUPPORTED_SCHEMA_VERSIONS in
 * ts/src/history/record.ts; an unstamped row is a legacy v2 row. A version we
 * do not know is refused, not reinterpreted -- the same rule the engine keeps.
 */
const SUPPORTED_SCHEMA_VERSIONS = [2, 3];

/** The shape problem with a parsed record, or null when it is usable. */
function recordProblem(record) {
  if (!isPlainObject(record)) return 'not an object';
  const version = record.schema_version ?? 2;
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(version)) {
    return `unsupported schema_version ${JSON.stringify(version)}`;
  }
  if (record.tests !== undefined && !Array.isArray(record.tests)) {
    return 'tests is not an array';
  }
  if ((record.tests ?? []).some((t) => !isPlainObject(t))) {
    return 'a tests entry is not an object';
  }
  return null;
}

function parseRecord(line, lineNo) {
  let record;
  try {
    record = JSON.parse(line);
  } catch (exc) {
    throw new Error(
      `malformed history record at line ${lineNo}: ${exc.message}`,
    );
  }
  const problem = recordProblem(record);
  if (problem) {
    throw new Error(`malformed history record at line ${lineNo}: ${problem}`);
  }
  return record;
}

/**
 * @param {string} file path to history-v2.jsonl
 * @returns {object[]} one record per non-blank line, in file order
 */
export function loadRuns(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`history store not found: ${file}`);
  }
  const runs = [];
  fs.readFileSync(file, 'utf8')
    .split(/\r\n|\r|\n/)
    .forEach((raw, i) => {
      const line = raw.trim();
      if (line) runs.push(parseRecord(line, i + 1));
    });
  return runs;
}

function parseLedger(file) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (exc) {
    throw new Error(`malformed quarantine ledger ${file}: ${exc.message}`);
  }
  if (!isPlainObject(doc)) {
    throw new Error(`malformed quarantine ledger ${file}: not an object`);
  }
  const rows = doc.entries ?? [];
  if (!Array.isArray(rows)) {
    throw new Error(`quarantine ledger entries must be an array: ${file}`);
  }
  const bad = rows.findIndex((row) => !isPlainObject(row));
  if (bad !== -1) {
    throw new Error(
      `malformed quarantine ledger ${file}: entry ${bad} is not an object`,
    );
  }
  return rows;
}

/**
 * @param {string} file ledger path
 * @param {boolean} explicit true when the caller passed --ledger
 * @returns {{state: 'read'|'dark', rows: object[], reason: string|null}}
 */
export function loadLedger(file, explicit) {
  if (fs.existsSync(file)) {
    return { state: 'read', rows: parseLedger(file), reason: null };
  }
  if (explicit) throw new Error(`quarantine ledger not found: ${file}`);
  return {
    state: 'dark',
    rows: [],
    reason: `no quarantine ledger at ${file}`,
  };
}
