// history -- read the run-history store canary-screech watches.
//
// The store is `test-results/reports/history-v2.jsonl`: one RunRecord JSON
// object per line (the shape in `ts/src/history/record.ts`). This module is the
// only part of the skill that touches the filesystem; everything downstream is
// pure.
//
// Deliberately NOT tolerant of a missing file. Returning `[]` there would be
// byte-identical to a genuinely empty store, and the caller would print an
// abstention -- a plausible-looking, wrong answer -- when the truth is that
// `--history` points at nothing. A typo'd path must look like a typo'd path.

import fs from 'node:fs';

/** The fields this skill reads. Everything else in the record is ignored. */

/**
 * Parse the JSONL store into records.
 *
 * @param {string} file path to history-v2.jsonl
 * @returns {object[]} one record per non-blank line, in file order
 */
export function loadRuns(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`history store not found: ${file}`);
  }
  const lines = fs.readFileSync(file, 'utf8').split(/\r\n|\r|\n/);
  const runs = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (exc) {
      throw new Error(
        `malformed history record at line ${i + 1}: ${exc.message}`,
      );
    }
    if (
      record === null ||
      typeof record !== 'object' ||
      Array.isArray(record)
    ) {
      throw new Error(
        `malformed history record at line ${i + 1}: not an object`,
      );
    }
    runs.push(record);
  }
  return runs;
}

/**
 * The runs for one branch, oldest first.
 *
 * Ordered by `timestamp`, not by file order: the store is append-only per
 * writer, and several suites append to it concurrently, so file order is not
 * chronological order. Getting this backwards would name the wrong run as the
 * first red one, which is the whole culprit range.
 *
 * @param {object[]} runs
 * @param {string} branch
 * @returns {object[]}
 */
export function runsForBranch(runs, branch) {
  return runs
    .filter((r) => r.branch === branch)
    .slice()
    .sort((a, b) =>
      String(a.timestamp ?? '').localeCompare(String(b.timestamp ?? '')),
    );
}
