// register -- the katana ledger as register[] rows (fork C).
//
// Author identity never reaches a public feed. A row with no provenance
// (katana writes '' when git history was unavailable) cannot carry the
// required recorded_at/commit/reason, so it is left out and counted rather
// than given an invented date.

import {
  loadLedger,
  DEFAULT_LEDGER,
} from '../../canary-signal/scripts/sources.mjs';

const TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const REQUIRED = ['test', 'file', 'kind', 'reason', 'commit'];

/** The provenance fields a ledger row lacks; [] when it can be a register row. */
function missingFields(r) {
  const missing = REQUIRED.filter((f) => !r[f]);
  if (!TIMESTAMP.test(r.date ?? '')) missing.push('date');
  return missing;
}

const skipNote = (r, missing) =>
  `ledger row ${r.file || '?'} :: ${r.test || '?'}: no ${missing.join(', ')}`;

function toRow(r, scope) {
  return {
    scope,
    title: r.test,
    file: r.file,
    kind: r.kind,
    reason: r.reason,
    recorded_at: r.date,
    commit: r.commit,
    cause: r.cause || null,
    issue: r.issue || null,
  };
}

export function registerRows(ledgerRows, scope) {
  const rows = [];
  const skipped = [];
  for (const r of ledgerRows) {
    const missing = missingFields(r);
    if (missing.length) skipped.push(skipNote(r, missing));
    else rows.push(toRow(r, scope));
  }
  return { rows, skipped };
}

/**
 * The ledger at `file` (or katana's default path when null) as register rows.
 * A dark default ledger and each left-out row are named in `notes`.
 * @throws when a ledger the caller named is missing or malformed
 */
export function ledgerRegister(file, scope, notes) {
  // parse-args initialises an unset value flag to null: null = not named.
  const ledger = loadLedger(file ?? DEFAULT_LEDGER, file !== null);
  if (ledger.state === 'dark') notes.push(ledger.reason);
  const { rows, skipped } = registerRows(ledger.rows, scope);
  notes.push(...skipped.map((s) => `left out ${s}`));
  return rows;
}
