// digest -- loud, categorized failure digest (pure). Ported behavior-for-
// behavior from the Python original.
//
// Turns a list of failures into a terse CI-log digest + `::error` workflow
// annotations + a non-zero exit code, so an engineer triages from the run log
// without opening the HTML report.

import { FAILURE_CATEGORIES, categorizeFailure } from './failures.mjs';

// Output glyphs kept as \u escapes so the source stays ASCII while the emitted
// text is byte-identical to the Python original.
const CHECK = '\u2705'; // white heavy check mark
const CROSS = '\u274c'; // cross mark
const DASH = '\u2014'; // em dash

/**
 * @typedef {{text: string, annotations: string[], exitCode: number}} Digest
 */

function firstLine(error, limit = 160) {
  if (!error) return '(no error message)';
  for (const raw of error.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (line) return line.slice(0, limit);
  }
  return '(no error message)';
}

/** Build the digest text, `::error` annotations, and exit code from failures. */
export function buildDigest(failures) {
  if (!failures.length) {
    return { text: `${CHECK} 0 failing tests.`, annotations: [], exitCode: 0 };
  }

  const n = failures.length;
  const byCat = new Map();
  for (const f of failures) {
    const cat = categorizeFailure(f.error);
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(f);
  }

  const lines = [
    `${CROSS} ${n} failing test${n !== 1 ? 's' : ''} ${DASH} triage by category:`,
    '',
  ];
  for (const cat of FAILURE_CATEGORIES) {
    const bucket = byCat.get(cat);
    if (!bucket || !bucket.length) continue;
    lines.push(`  ${cat} (${bucket.length}):`);
    for (const f of bucket) {
      lines.push(`    - ${f.title} ${DASH} ${firstLine(f.error)}`);
    }
  }
  const text = lines.join('\n');

  const annotations = [];
  for (const f of failures) {
    const cat = categorizeFailure(f.error);
    let loc = '';
    if (f.file) loc += `file=${f.file},`;
    if (f.line !== null && f.line !== undefined) loc += `line=${f.line},`;
    annotations.push(
      `::error ${loc}title=Test failure::${f.title} ${DASH} ${cat}: ${firstLine(f.error)}`,
    );
  }

  return { text, annotations, exitCode: 1 };
}
