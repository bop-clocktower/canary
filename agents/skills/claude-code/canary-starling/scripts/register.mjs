// register -- the katana ledger as register[] rows (fork C).
//
// Author identity never reaches a public feed. A row with no provenance
// (katana writes '' when git history was unavailable) cannot carry the
// required recorded_at/commit/reason, so it is left out and counted rather
// than given an invented date.

const TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const REQUIRED = ['test', 'file', 'kind', 'reason', 'commit'];

export function registerRows(ledgerRows, scope) {
  const rows = [];
  const skipped = [];
  for (const r of ledgerRows) {
    const missing = REQUIRED.filter((f) => !r[f]);
    if (!TIMESTAMP.test(r.date ?? '')) missing.push('date');
    if (missing.length) {
      skipped.push(
        `ledger row ${r.file || '?'} :: ${r.test || '?'}: no ${missing.join(', ')}`,
      );
      continue;
    }
    rows.push({
      scope,
      title: r.test,
      file: r.file,
      kind: r.kind,
      reason: r.reason,
      recorded_at: r.date,
      commit: r.commit,
      cause: r.cause || null,
      issue: r.issue || null,
    });
  }
  return { rows, skipped };
}
