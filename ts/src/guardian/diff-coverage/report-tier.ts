/**
 * Tier 1 — coverage resolved from an explicit report (`COVERAGE_VERIFIED`).
 *
 * Owns the lcov reader, the format dispatch (which report shape is this file?),
 * and the per-unit matching that turns a report index into verdicts.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { parseCobertura } from './formats/cobertura.js';
import { parseCoverageJson } from './formats/coverage-json.js';
import {
  expandRanges,
  makeResult,
  matchFile,
  rangesStr,
  selfDescribing,
  splitLines,
  pyInt,
  Fidelity,
  type ChangedUnit,
  type CoverageResult,
  type LineHits,
  type ReportIndex,
} from './types.js';

/**
 * Parse `lcov.info` into `{path: {line: hits}}`.
 *
 * Every `DA:` record is a line the instrumenter measured, so the recorded lines
 * are exactly the coverable set — see `FileCoverage`.
 */
function parseLcov(text: string): ReportIndex {
  const byPath: Record<string, LineHits> = {};
  let current: string | null = null;
  for (const line of splitLines(text)) {
    if (line.startsWith('SF:')) {
      current = line.slice(3).trim();
      if (!(current in byPath)) byPath[current] = {};
    } else if (line.startsWith('DA:') && current !== null) {
      recordDa(byPath[current]!, line.slice(3).trim());
    } else if (line.trim() === 'end_of_record') {
      current = null;
    }
  }
  const index: ReportIndex = {};
  for (const [path, hits] of Object.entries(byPath)) {
    index[path] = selfDescribing(hits);
  }
  return index;
}

/** Fold one `DA:<line>,<hits>` body into a file's hit map, skipping junk. */
function recordDa(hits: LineHits, body: string): void {
  const parts = body.split(',');
  if (parts.length < 2) return;
  const lineno = pyInt(parts[0]!);
  const count = pyInt(parts[1]!);
  if (lineno === null || count === null) return;
  hits[lineno] = count;
}

/** Read a report file as UTF-8, returning `null` on any read/decode failure. */
function readReportText(reportPath: string): string | null {
  try {
    const buf = readFileSync(reportPath);
    // Fatal decode: a non-UTF-8 report must fall through, never raise out of
    // the guardian gate (mirrors Python's UnicodeDecodeError → None).
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

/**
 * Tier 1: resolve coverage from an explicit report (`COVERAGE_VERIFIED`).
 *
 * Supports `lcov.info` (`DA:<line>,<hits>`), the canary coverage-json shape,
 * and Cobertura `coverage.xml` (line-level). Unrecognized/empty/unreadable →
 * `null` (caller falls through to a lower fidelity tier — absence never
 * blocks).
 */
export function resolveFromReport(
  units: ChangedUnit[],
  reportPath: string,
): CoverageResult[] | null {
  const { index } = readReportIndex(reportPath);
  if (index === null) return null;
  return matchUnitsToIndex(units, index);
}

/**
 * What a coverage-report read actually yielded (#554).
 *
 * `found` is "a file exists at that path"; `index` is non-null only when the
 * file also parsed into at least one record. Keeping the two apart is the whole
 * point: "no report" and "a report we could not use" degrade identically today
 * and are separate operator problems.
 */
interface ReportRead {
  found: boolean;
  index: ReportIndex | null;
}

/** Read + parse a coverage report, reporting each step's outcome separately. */
export function readReportIndex(reportPath: string): ReportRead {
  const unusable = (found: boolean): ReportRead => ({ found, index: null });

  if (!existsSync(reportPath)) return unusable(false);
  const text = readReportText(reportPath);
  // Present but unreadable/non-UTF-8 counts as found-and-unusable, not absent.
  if (text === null) return unusable(true);

  const index = parseByFormat(basename(reportPath).toLowerCase(), text);
  if (index === null || Object.keys(index).length === 0) return unusable(true);
  return { found: true, index };
}

/** Pick the reader by report filename; `null` for a format we don't know. */
function parseByFormat(name: string, text: string): ReportIndex | null {
  if (name.endsWith('.json')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    return parseCoverageJson(parsed);
  }
  if (name.endsWith('.info') || name.includes('lcov')) return parseLcov(text);
  if (name.endsWith('.xml')) return parseCobertura(text);
  // Unrecognized format → fall through to a lower fidelity tier.
  return null;
}

/** Resolve every unit the report index can speak to (COVERAGE_VERIFIED). */
export function matchUnitsToIndex(
  units: ChangedUnit[],
  index: ReportIndex,
): CoverageResult[] {
  const results: CoverageResult[] = [];
  for (const unit of units) {
    const file = matchFile(unit.path, index);
    if (file === null) {
      // Unit path is nowhere in the report index → "not instrumented", which is
      // NOT the same as "instrumented and unhit". Emit no COVERAGE_VERIFIED
      // result so the orchestrator falls through to a lower-fidelity tier for
      // this unit (FIX 2).
      continue;
    }
    const { hits, coverable: measured } = file;
    const added = expandRanges(unit.added_ranges);
    // The per-line form of the check above (#655/#657): where the report says
    // which lines it instrumented, a changed line outside that set could not
    // have been executed and is scored by neither side. Where it does not say,
    // every changed line counts and absence means uncovered.
    const coverable =
      measured === null ? added : added.filter((ln) => measured.has(ln));
    if (coverable.length === 0) {
      // Every changed line is non-coverable, so this report has nothing to say
      // about the unit. An abstention — never a clean pass, never a finding.
      // Falls through to the graph/heuristic tier exactly as an absent path does.
      continue;
    }
    const uncovered = coverable.filter((ln) => (hits[ln] ?? 0) <= 0);
    const covered = uncovered.length === 0;
    // State the denominator: "all covered" over 20 changed lines and over the 3
    // of them that were coverable are very different claims (#508).
    const evidence = covered
      ? `lines ${rangesStr(unit.added_ranges)}: all ${coverable.length} coverable line(s) covered`
      : `lines ${rangesStr(unit.added_ranges)}: ${uncovered.length} of ${coverable.length} coverable line(s) uncovered`;
    results.push(
      makeResult({
        unit,
        covered,
        fidelity: Fidelity.CoverageVerified,
        evidence,
        uncovered_lines: uncovered,
        coverable_lines: coverable.length,
      }),
    );
  }
  return results;
}
