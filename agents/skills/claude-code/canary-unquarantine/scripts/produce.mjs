// produce -- the quarantine side: one entry point that writes the ledger row
// AND the marker together, and a one-shot migration of markers that have no
// row into the ledger.
//
// Why one entry point: a marker with no row is a skip nobody can chase, and a
// row with no marker (stale) claims a quarantine the code does not have. The
// only way to keep them in step is to never write one without the other.
//
// Why a migration: suites that quarantine by tag (`@known-failure` plus a
// ticket URL in a comment) or by bare skip have markers and no ledger. The
// migration turns each unledgered marker into a row, keeping every ticket
// reference it carried exactly as written, so the audit can then chase it.

import fs from 'node:fs';

import * as ledgerIo from '../../canary-katana/scripts/ledger.mjs';
import { applyEdits, planQuarantine } from './lift.mjs';
import { locate, readSource } from './markers.mjs';

const stripTags = (title, tags) =>
  tags
    .reduce((t, tag) => t.split(tag).join(''), title)
    .replace(/\s+/g, ' ')
    .trim();

/** One ledger row per unledgered marker. The first reference becomes `issue`; the rest stay in `reason`. */
export function planMigration(unledgered, { tags, now = new Date() }) {
  return unledgered.map((m) => {
    const [issue = '', ...also] = m.links ?? [];
    const extra = also.length ? `; also ${also.join(', ')}` : '';
    return ledgerIo.LedgerEntry({
      test: stripTags(m.test, tags),
      file: m.file,
      kind: 'skipped',
      marker: m.marker,
      author: 'canary-unquarantine migrate',
      date: now.toISOString(),
      reason: `migrated from an unledgered ${m.marker} marker${extra}`,
      issue,
    });
  });
}

/** `migrate`: show the rows the unledgered markers become; with --yes, append them. */
export function migrateCommand(args, { runAudit, print }) {
  const { result, ledgerPath, tags } = runAudit({ ...args, noScan: false });
  const rows = planMigration(result.unledgered, { tags });
  const linked = rows.filter((r) => r.issue).length;
  const doc = {
    command: 'migrate',
    scanned_files: result.scannedFiles,
    checked: rows.length,
    linked,
    written: false,
    rows,
  };
  if (!rows.length) {
    const why = result.scannedFiles
      ? `${result.scannedFiles} test file(s) read and every marker already has a row`
      : 'no test files were read';
    print({ ...doc, abstained: !result.scannedFiles, why }, () =>
      result.scannedFiles
        ? `Nothing to migrate: ${why}.`
        : `\u{26A0} Abstained \u{2014} nothing to migrate: ${why}.`,
    );
    return args.strict && !result.scannedFiles ? 3 : 0;
  }
  if (args.yes) ledgerIo.appendEntries(ledgerPath, rows);
  const lines = [
    `${args.yes ? 'Migrated' : 'Would migrate'} ${rows.length} unledgered marker(s) into ${ledgerPath}: ${linked} with a ticket link, ${rows.length - linked} unlinked.`,
    ...rows.map(
      (r) =>
        `  - ${r.file} \u{2014} ${r.test} (${r.marker})${r.issue ? ` \u{2192} ${r.issue}` : ' \u{2192} NO TICKET'}`,
    ),
    args.yes
      ? ''
      : '\nNothing has been written. Re-run with --yes to append these rows.',
  ];
  print({ ...doc, written: Boolean(args.yes), abstained: false }, () =>
    lines.join('\n').trimEnd(),
  );
  return 0;
}

/** Why a quarantine request is refused, or null. */
function refusal({ file, test, cause, issue }) {
  if (!file || !test) return 'quarantine needs --file and --test';
  if (!ledgerIo.CAUSES.includes(cause))
    return `--cause must be one of ${ledgerIo.CAUSES.join(', ')}`;
  if (ledgerIo.CAUSES_REQUIRING_ISSUE.includes(cause) && !issue) {
    return `a ${cause} quarantine needs --issue: the test is correct and someone else owns the fix, so a row with no ticket decays into an unexplained skip`;
  }
  return null;
}

/**
 * Switch one test off and record it: the marker (with a comment naming the
 * ticket) and the ledger row are written together, or neither is.
 *
 * @returns {{row: object, markerLine: number} | {why: string}}
 */
function quarantineTest({
  repo,
  ledgerPath,
  file,
  test,
  cause,
  issue = '',
  expiry = '',
  tags = [],
  asTag = false,
  now = new Date(),
}) {
  const refused = refusal({ file, test, cause, issue });
  if (refused) return { why: refused };
  ledgerIo.load(ledgerPath); // a corrupt ledger throws here, before any file is touched
  const src = readSource(repo, file);
  const loc = locate(src, { test, file, marker: '' }, tags);
  if (!loc.found) return { why: loc.why };
  if (loc.marked)
    return {
      why: `"${test}" in ${file} is already switched off (line ${loc.markerLine})`,
    };
  const decl = { line: loc.line, title: test, lang: src.lang };
  const note = `Quarantined against ${issue || '(no ticket)'} (${cause}) by canary-unquarantine`;
  const plan = planQuarantine(src.lines, decl, {
    note,
    tag: asTag ? tags[0] : undefined,
  });
  if ('why' in plan) return plan;
  const row = ledgerIo.LedgerEntry({
    test,
    file,
    kind: 'skipped',
    marker: plan.marker,
    author: 'canary-unquarantine quarantine',
    date: now.toISOString(),
    reason: `quarantine: ${cause}${issue ? ` against ${issue}` : ''}`,
    cause,
    issue,
    expiry,
  });
  fs.writeFileSync(
    `${repo}/${file}`,
    applyEdits(src.lines, plan.edits).join('\n'),
    'utf8',
  );
  ledgerIo.appendEntries(ledgerPath, [row]);
  return { row, markerLine: loc.line + 1 };
}

/** `quarantine`: one test off, marker and row together. */
export function quarantineCommand(args, { ledgerPath, print, tags }) {
  const done = quarantineTest({
    repo: args.repo,
    ledgerPath,
    file: args.file,
    test: args.test,
    cause: args.cause,
    issue: args.issue,
    expiry: args.expiry,
    tags,
    asTag: args.asTag,
  });
  if ('why' in done) throw new Error(done.why);
  const { row } = done;
  print(
    { command: 'quarantine', ...done },
    () =>
      `Quarantined ${row.test} (${row.file}) with ${row.marker}, against ${row.issue || 'no ticket'}; ledger row written to ${ledgerPath}.`,
  );
  return 0;
}
