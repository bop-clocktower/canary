/**
 * Tier 3 — the last-resort naming/AST heuristic (`HEURISTIC`, never `null`).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, posix } from 'node:path';

import { isTestPath } from './paths.js';
import {
  makeResult,
  stem,
  Fidelity,
  type ChangedUnit,
  type CoverageResult,
} from './types.js';

/**
 * Derive candidate symbol names for a unit: the file stem plus top-level
 * `def`/`class` names. Python uses `ast` for `.py`; here a column-0 line scan
 * approximates top-level extraction (indented, nested defs are excluded, just
 * as `ast.parse(...).body` would exclude them). A cheap regex covers other
 * languages.
 *
 * KNOWN HEURISTIC-TIER LIMITATION: unlike a real AST, this lexical scan can pick
 * up a phantom `def ghost()`/`class Phantom` sitting at column 0 inside a
 * triple-quoted string or in a syntactically-broken file, yielding a false
 * heuristic-covered verdict if a test happens to mention that name. Full `ast`
 * parity is not portable to Node; this is accepted as a lowest-fidelity-tier
 * (HEURISTIC) imprecision — the report and graph tiers, which outrank it, are
 * exact. (A cheap mitigation would be to blank string literals before the scan,
 * omitted here to avoid any risk of dropping a real top-level symbol.)
 */
function extractSymbols(unitPath: string, repoRoot: string): Set<string> {
  const symbols = new Set<string>([stem(unitPath)]);
  let source: string;
  try {
    source = readFileSync(join(repoRoot, unitPath), 'utf-8');
  } catch {
    return symbols;
  }
  const decl = unitPath.endsWith('.py')
    ? /^(?:async\s+def|def|class)\s+([A-Za-z_]\w*)/gm
    : /\b(?:function|class|def|const|let|var)\s+([A-Za-z_]\w*)/g;
  for (let m = decl.exec(source); m !== null; m = decl.exec(source)) {
    symbols.add(m[1]!);
  }
  return symbols;
}

/** Recursively list every file under `root` (sorted for determinism). */
function walkFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** Relative POSIX path of `full` under `root`. */
function relPosix(root: string, full: string): string {
  const rel = full.slice(root.length).replace(/^[/\\]/, '');
  return rel.split(/[/\\]/).join(posix.sep);
}

/** Yield `[relPath, text]` for every test-looking file under `repoRoot`. */
function iterTestFiles(repoRoot: string): Array<[string, string]> {
  const all = walkFiles(repoRoot);
  const seen = new Set<string>();
  const out: Array<[string, string]> = [];

  const emit = (full: string): void => {
    if (seen.has(full)) return;
    seen.add(full);
    let text: string;
    try {
      text = readFileSync(full, 'utf-8');
    } catch {
      return;
    }
    out.push([relPosix(repoRoot, full), text]);
  };

  const matchers: Array<(base: string) => boolean> = [
    (b) => /^test_.*\.py$/.test(b),
    (b) => b.includes('.test.'),
    (b) => b.includes('.spec.'),
  ];
  for (const matches of matchers) {
    for (const full of all) {
      if (matches(basename(full))) emit(full);
    }
  }
  // Also any file living under a tests/ directory (broader net).
  for (const full of all) {
    if (!full.endsWith('.py')) continue;
    if (isTestPath(relPosix(repoRoot, full))) emit(full);
  }
  return out;
}

/**
 * Tier 3: last-resort naming/AST heuristic (`HEURISTIC`, never `null`).
 *
 * A unit is heuristic-covered iff some test file under `repoRoot` references
 * the unit's file stem or a top-level symbol name (word-boundary scan).
 */
export function resolveFromHeuristic(
  units: ChangedUnit[],
  repoRoot = '.',
): CoverageResult[] {
  const testFiles = iterTestFiles(repoRoot);
  const results: CoverageResult[] = [];
  for (const unit of units) {
    const symbols = extractSymbols(unit.path, repoRoot);
    // Avoid pathological single-letter stems matching everything.
    const patterns: RegExp[] = [];
    for (const sym of symbols) {
      if (sym.length >= 2) patterns.push(new RegExp(`\\b${escapeRe(sym)}\\b`));
    }
    let covering: string | null = null;
    for (const [rel, text] of testFiles) {
      // A file never counts as covering itself.
      if (rel === unit.path) continue;
      if (patterns.some((pat) => pat.test(text))) {
        covering = rel;
        break;
      }
    }
    const covered = covering !== null;
    const evidence = covered
      ? `referenced by ${covering}`
      : `no test file references ${stem(unit.path)}`;
    results.push(
      makeResult({
        unit,
        covered,
        fidelity: Fidelity.Heuristic,
        evidence,
      }),
    );
  }
  return results;
}

/** Escape a string for literal use inside a RegExp (Python's `re.escape`). */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
