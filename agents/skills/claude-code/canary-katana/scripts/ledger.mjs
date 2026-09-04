// ledger -- the quarantine record for tests that are out of the suite.
//
// Every captured deletion is written with its provenance (who, when, what
// commit, why) so a test that vanishes leaves a trail instead of a silent gap.
// The ledger is de-duplicated: re-running the capture on the same change adds
// nothing, and a batch of new entries is sorted for a stable on-disk order.
//
// SCHEMA v2 (#771) adds the WHY a row is out, alongside the provenance of how it
// left: `cause`, `issue`, `expiry`. Two fields deserve their separation --
// `reason` is DERIVED (the commit subject, "what change did this"), `cause` is
// ASSERTED (a judgement someone made, "why is it out"). Collapsing them would
// dress an auto-derived string up as a claim a person stands behind.
//
// v2 also makes the ledger no longer purely append-only, for one narrow case
// documented at `appendEntries`: a row that states a cause SUPERSEDES a causeless
// row for the same (test, file). See the comment there for why leaving both is
// worse than replacing one.

import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA_VERSION = 2;

// The fields, in the order they define a row's identity for de-duplication.
const FIELDS = [
  'test',
  'file',
  'kind',
  'marker',
  'commit',
  'author',
  'date',
  'reason',
  'cause',
  'issue',
  'expiry',
];

/**
 * Why a test is out of the suite. The two middle values are the ones where the
 * TEST IS CORRECT and someone else owns the fix, so a producer must require an
 * `issue` for them -- an untracked "the product is broken" note decays into an
 * unexplained skip within a release.
 */
export const CAUSES = ['flaky', 'product-defect', 'blocked-data', 'obsolete'];

/** Causes for which a row without an `issue` is not a real record. */
export const CAUSES_REQUIRING_ISSUE = ['product-defect', 'blocked-data'];

/**
 * @typedef {{test: string, file: string, kind: string, marker: string,
 *            commit: string, author: string, date: string, reason: string,
 *            cause: string, issue: string, expiry: string}} LedgerRow
 */

/** Normalize an entry-like object into a row with the canonical field order. */
export function LedgerEntry(fields) {
  const row = {};
  for (const f of FIELDS) row[f] = fields[f] ?? '';
  // v1 wrote the tracker link as `ticket` (#781). It is the same fact under a
  // different name, so it migrates onto `issue` rather than being dropped or
  // kept alongside -- two fields answering "what is this waiting on" is how a
  // consumer ends up reading the empty one. `Ticket:` survives as the name of
  // the COMMIT TRAILER that populates it, which is a mechanism, not a schema.
  if (!row.issue && typeof fields.ticket === 'string')
    row.issue = fields.ticket;
  return row;
}

// The subset that defines a row's IDENTITY for de-duplication.
//
// `issue` and `expiry` are excluded, for the reason #781 excluded `ticket`:
// identity is what happened -- which test, in which file, muted how, by which
// commit and why -- and a tracker link is an attribute of that event rather
// than part of it. Including them would also break the append-only guarantee
// across this schema change, since rows written before the fields existed key
// as `''` and the same capture re-run with an issue present would hash
// differently and append a duplicate of a row already on disk.
//
// `cause` IS identity, and deliberately so: `appendEntries` decides supersede
// on whether a row states one, so a caused and a causeless row for the same
// test must remain distinguishable here for that decision to have anything to
// act on.
const IDENTITY_FIELDS = FIELDS.filter((f) => f !== 'issue' && f !== 'expiry');

const key = (row) => IDENTITY_FIELDS.map((f) => row[f] ?? '').join('\u0000');

/** The (test, file) pair a supersede decision is made on. */
const pair = (row) => `${row.test ?? ''}\u0000${row.file ?? ''}`;

/**
 * Load the ledger document, or an empty one when the file is absent.
 * Throws on unparseable JSON or a non-object top level -- a corrupt ledger is a
 * hard error the caller must surface, not silently overwrite.
 *
 * Every row is normalized through `LedgerEntry`, so a v1 file read here comes
 * back with the v2 fields present and empty. That is what makes writing
 * `schema_version: 2` honest: the version claims "these rows have these fields",
 * and after normalization they do. Stamping the version over un-migrated rows
 * would make it a promise the file does not keep.
 * @returns {{schema_version: number, entries: LedgerRow[]}}
 */
export function load(filePath) {
  if (!fs.existsSync(filePath)) {
    return { schema_version: SCHEMA_VERSION, entries: [] };
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (exc) {
    throw new Error(`ledger is not valid JSON: ${filePath}: ${exc.message}`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`ledger top level must be an object: ${filePath}`);
  }
  if (!('schema_version' in data)) data.schema_version = SCHEMA_VERSION;
  if (!('entries' in data)) data.entries = [];
  if (!Array.isArray(data.entries)) {
    throw new Error(`ledger entries must be an array: ${filePath}`);
  }
  data.entries = data.entries.map((e) => LedgerEntry(e));
  return data;
}

/**
 * Append `entries` to the ledger at `filePath` and persist it. New entries are
 * sorted by (file, test) and de-duplicated against the batch and disk.
 *
 * ONE ROW PER (test, file) MAY STATE A CAUSE, and a caused row wins:
 *
 *   - a new row WITH a cause replaces a causeless row for the same pair
 *   - a new row WITHOUT a cause is dropped when a caused row already exists
 *
 * Without this, katana recording `{kind: 'skipped', cause: ''}` and a quarantine
 * writer recording `{kind: 'skipped', cause: 'product-defect', issue: '#123'}`
 * differ in `key()` and BOTH persist. A consumer that fails on an unlinked
 * quarantine (canary-ci-ready does) then fails on the causeless row while the
 * linked row sits beside it -- the ledger contradicting itself about one test.
 *
 * History is not lost to this: rows that differ in cause-bearing state are the
 * only ones that collapse. Two caused rows, or two causeless rows, keep the
 * full-field identity and both remain.
 */
export function appendEntries(filePath, entries) {
  const doc = load(filePath);
  const existing = doc.entries;
  const seen = new Set(existing.map(key));
  const causedPairs = new Set(existing.filter((r) => r.cause).map(pair));

  const newRows = entries
    .map((e) => LedgerEntry(e))
    .sort(
      (a, b) => a.file.localeCompare(b.file) || a.test.localeCompare(b.test),
    );

  for (const row of newRows) {
    const k = key(row);
    if (seen.has(k)) continue;
    const p = pair(row);

    if (row.cause) {
      // Supersede: drop any causeless row for this pair, then take its place.
      for (let i = existing.length - 1; i >= 0; i--) {
        if (!existing[i].cause && pair(existing[i]) === p) {
          seen.delete(key(existing[i]));
          existing.splice(i, 1);
        }
      }
      causedPairs.add(p);
    } else if (causedPairs.has(p)) {
      // A causeless row must never sit next to a caused one for the same test.
      continue;
    }

    seen.add(k);
    existing.push(row);
  }

  doc.schema_version = SCHEMA_VERSION;
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  return doc;
}
