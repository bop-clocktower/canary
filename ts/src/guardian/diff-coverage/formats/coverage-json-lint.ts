/**
 * The producer-facing lint for coverage-json: it reports, loudly, exactly what
 * `./coverage-json.ts` would silently accept-and-drop. Split one validator per
 * field so each stays readable and the parser it mirrors stays adjacent.
 */

import {
  COVERAGE_JSON_SCHEMA_VERSION,
  isSupportedSchemaVersion,
} from './coverage-json.js';
import { isInt, isRecord, pyInt, type LineHits } from '../types.js';

/**
 * One issue found validating a coverage-json document against the contract.
 *
 * `error`   — `parseCoverageJson` cannot use this (whole doc → null, or
 * a file entry is dropped): coverage is *lost*.
 * `warning` — the parser ignores a sub-part but still uses the rest: coverage
 * is *degraded*, not lost.
 */
export interface CoverageProblem {
  severity: 'error' | 'warning';
  location: string;
  message: string;
}

/** Where a validator sends what it finds. */
interface Reporter {
  err: (location: string, message: string) => void;
  warn: (location: string, message: string) => void;
}

/**
 * Validate a coverage-json document against the v1 producer contract.
 *
 * Reports, loudly, exactly what `parseCoverageJson` would silently
 * accept-and-drop, at two severities. Never raises and never mutates — it is a
 * lint for producers, mirroring the parser it lives beside so the two cannot
 * drift.
 */
export function validateCoverageJson(data: unknown): CoverageProblem[] {
  const problems: CoverageProblem[] = [];
  const report: Reporter = {
    err: (location, message) =>
      void problems.push({ severity: 'error', location, message }),
    warn: (location, message) =>
      void problems.push({ severity: 'warning', location, message }),
  };

  if (!isRecord(data)) {
    report.err('(root)', 'top-level value must be a JSON object');
    return problems;
  }

  const version = data['schema_version'];
  if (!isSupportedSchemaVersion(version)) {
    report.err(
      'schema_version',
      `unsupported schema_version ${repr(version)}; this build understands ` +
        `v${COVERAGE_JSON_SCHEMA_VERSION} (omit the field to default to it)`,
    );
  }

  const files = data['files'];
  if (files === undefined || files === null) {
    report.err('files', "missing required 'files' object");
    return problems;
  }
  if (!isRecord(files)) {
    report.err('files', "'files' must be an object mapping path -> coverage");
    return problems;
  }

  for (const [path, entry] of Object.entries(files)) {
    validateFileEntry(`files['${path}']`, entry, report);
  }

  return problems;
}

/** Validate one `files[path]` entry, mirroring what the parser keeps. */
function validateFileEntry(
  loc: string,
  entry: unknown,
  report: Reporter,
): void {
  if (!isRecord(entry)) {
    report.err(loc, "entry must be an object; this file's coverage is dropped");
    return;
  }

  // Mirror the parser's surviving hit map so the verdict is bound to what
  // the parser actually keeps.
  const recorded: LineHits = {};
  validateLineHits(entry['line_hits'], recorded, loc, report.warn);
  validateCoveredLines(entry['covered_lines'], recorded, loc, report.warn);

  if (Object.keys(recorded).length === 0) {
    report.warn(loc, 'no usable coverage lines; contributes nothing');
  }

  validateInstrumentedLines(entry, recorded, loc, report.warn);
}

/** Check `line_hits`, recording into `recorded` every entry the parser keeps. */
function validateLineHits(
  lineHits: unknown,
  recorded: LineHits,
  loc: string,
  warn: Reporter['warn'],
): void {
  if (lineHits === undefined || lineHits === null) return;
  if (!isRecord(lineHits)) {
    warn(`${loc}.line_hits`, 'must be an object mapping line -> hits; ignored');
    return;
  }
  for (const [k, v] of Object.entries(lineHits)) {
    const kloc = `${loc}.line_hits['${k}']`;
    if (!isInt(v)) {
      warn(kloc, `hits ${repr(v)} is not an integer; dropped`);
      continue;
    }
    if (v < 0) {
      warn(kloc, `hits ${v} is negative; dropped`);
      continue;
    }
    const lineno = pyInt(k);
    if (lineno === null) {
      warn(kloc, 'line key is not an integer; dropped');
      continue;
    }
    if (lineno < 1) {
      warn(kloc, 'line number must be >= 1; dropped');
      continue;
    }
    recorded[lineno] = v;
  }
}

/** Check `covered_lines`, folding the survivors into `recorded` as the parser does. */
function validateCoveredLines(
  covered: unknown,
  recorded: LineHits,
  loc: string,
  warn: Reporter['warn'],
): void {
  if (covered === undefined || covered === null) return;
  if (!Array.isArray(covered)) {
    warn(`${loc}.covered_lines`, 'must be an array of line numbers; ignored');
    return;
  }
  covered.forEach((lineno, i) => {
    const cloc = `${loc}.covered_lines[${i}]`;
    if (!isInt(lineno)) {
      warn(cloc, `${repr(lineno)} is not an integer; dropped`);
      return;
    }
    if (lineno < 1) {
      warn(cloc, 'line number must be >= 1; dropped');
      return;
    }
    if (!(lineno in recorded)) {
      recorded[lineno] = 1;
      return;
    }
    if (recorded[lineno] === 0) {
      warn(
        cloc,
        `line ${lineno} is also in line_hits as unhit (0); ` +
          'line_hits wins, so it stays uncovered',
      );
    }
    // a positive line_hits count makes this entry redundant
  });
}

/**
 * Check a file entry's `instrumented_lines`, and nudge producers that need it.
 *
 * Two jobs. The shape checks mirror the parser, as everywhere else in this
 * validator. The interesting one is the **ambiguity** warning: a document
 * leaning on `covered_lines` cannot express an unhit line *or* a
 * non-instrumented one, so every line it omits lands downstream as a coverage
 * gap. That is exactly what transcoding lcov into this format produces, and it
 * is the failure #657 exists to close — the producer sees success while the
 * consumer invents findings. Silence there would be the same shape this repo
 * keeps closing, so the validator says it out loud.
 *
 * It is deliberately scoped to `covered_lines`, the field that *structurally*
 * cannot report a miss. A `line_hits` document with no zeros is not evidence of
 * the same mistake: that producer can express an unhit line and simply had none
 * to report, which is what a fully-covered file looks like. Warning there would
 * fire on correct documents, and a warning that cries wolf is one producers
 * learn to skip — the precision lesson from #553.
 *
 * The warning clears as soon as the document is unambiguous by either route: a
 * declared `instrumented_lines`, or an explicit `0` in `line_hits`. A producer
 * already doing the right thing must not be nagged toward a second mechanism.
 */
function validateInstrumentedLines(
  entry: Record<string, unknown>,
  recorded: LineHits,
  loc: string,
  warn: Reporter['warn'],
): void {
  const declaration = entry['instrumented_lines'];
  const dloc = `${loc}.instrumented_lines`;

  if (declaration === undefined || declaration === null) {
    const usesShorthand = Array.isArray(entry['covered_lines']);
    const declaresAMiss = Object.values(recorded).includes(0);
    if (usesShorthand && !declaresAMiss) {
      warn(
        loc,
        "reports coverage via 'covered_lines', which cannot express an unhit " +
          'line, so a changed line this document omits is read as uncovered — ' +
          'a line that was never instrumented (a comment, an import, a type ' +
          "declaration) becomes a coverage gap. Declare 'instrumented_lines', " +
          'or record unhit lines as line_hits 0',
      );
    }
    return;
  }

  if (!Array.isArray(declaration)) {
    warn(dloc, 'must be an array of line numbers; ignored');
    return;
  }

  declaration.forEach((lineno, i) => {
    if (!isInt(lineno)) {
      warn(`${dloc}[${i}]`, `${repr(lineno)} is not an integer; dropped`);
      return;
    }
    if (lineno < 1) {
      warn(`${dloc}[${i}]`, 'line number must be >= 1; dropped');
    }
  });

  // A recorded line the declaration omits is a producer contradicting itself.
  // The parser keeps the measurement, so this costs no coverage — but a
  // declaration that disagrees with the data is worth hearing about.
  const declared = new Set(declaration.filter(isInt));
  const undeclared = Object.keys(recorded)
    .map(Number)
    .filter((ln) => !declared.has(ln));
  if (undeclared.length > 0) {
    warn(
      dloc,
      `line(s) ${undeclared.join(', ')} have coverage data but are not ` +
        'declared instrumented; the measurement wins and they stay coverable',
    );
  }
}

/** Rough analog of Python's `repr()` for scalar diagnostic values. */
function repr(value: unknown): string {
  if (typeof value === 'string') return `'${value}'`;
  // Match Python's `{v!r}` spelling of the JSON scalars so warning messages
  // read byte-for-byte like the oracle (true→True, false→False, null→None).
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (value === null) return 'None';
  return String(value);
}
