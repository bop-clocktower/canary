// findings -- one Tier-0 detector `--json` envelope, as test-defect evidence.
//
// savant, blackhawk, cassandra and katana share the envelope
// `{schema_version, findings: [{file, line, rule_id, ...}], summary}`, so one
// optional file covers every detector. This skill never RUNS a detector (F4).
//
// Only findings on the target's own test file count. The detector's free-text
// `snippet`/`why` is never echoed: the brief quotes rule id and location only,
// so its no-verdict guard holds for text it did not write.

import fs from 'node:fs';

import { row, samePath } from './signals.mjs';

const SOURCE = 'detector findings';

const isPlainObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** A named file that is missing or malformed is an error (D9). */
export function loadFindings(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`findings file not found: ${file}`);
  }
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (exc) {
    throw new Error(`malformed findings file ${file}: ${exc.message}`);
  }
  if (!isPlainObject(doc) || !Array.isArray(doc.findings)) {
    throw new Error(`malformed findings file ${file}: no findings array`);
  }
  return doc.findings.filter(isPlainObject);
}

/** Findings quoted by name before the rest are only counted. */
const LISTED = 5;

function label(finding) {
  const rule = finding.rule_id ?? finding.kind ?? 'unnamed rule';
  return finding.line == null ? rule : `${rule}@${finding.line}`;
}

// ONE row for every finding on the file: one row per finding would stack a
// long list under test-defect and read as weight by volume (S2).
function toRow(onFile, testFile) {
  const listed = onFile.slice(0, LISTED).map(label);
  if (onFile.length > LISTED) listed.push(`+${onFile.length - LISTED} more`);
  const detail =
    `${onFile.length} finding(s) on ${testFile}: ${listed.join(', ')}; ` +
    'a static finding on the file does not by itself connect to this failure';
  return row('detector-finding', SOURCE, detail, ['test-defect']);
}

function skipped(reason) {
  return { rows: [], notChecked: [{ source: SOURCE, reason }] };
}

/**
 * @param {object[]|null} findings null when no --findings was given
 * @param {string|null} testFile the target observation's test_file
 */
export function findingsEvidence(findings, testFile) {
  if (findings === null) return skipped('no --findings file given');
  if (!testFile) {
    return skipped(
      'the target observation records no test_file to match findings against',
    );
  }
  const onFile = findings.filter(
    (f) => typeof f.file === 'string' && samePath(f.file, testFile),
  );
  const rows = onFile.length ? [toRow(onFile, testFile)] : [];
  return { rows, notChecked: [] };
}
