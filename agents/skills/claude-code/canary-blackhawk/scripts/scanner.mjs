// Line scanner: turns test sources into temporal-dependency findings (pure).
//
// Regex/AST-lite by design -- no parser dependency, standard library only -- so
// it ships wherever node does. See SKILL.md for the fidelity limits that buys.

import fs from 'node:fs';
import path from 'node:path';

import { FROZEN_CLOCK_MARKERS, RULES } from './rules.mjs';

export const SNIPPET_LIMIT = 120;

export const SUPPORTED_SUFFIXES = [
  '.py',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
];

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'build',
  '.mypy_cache',
  '.pytest_cache',
  '.tox',
]);

const TEST_DIRS = new Set(['tests', 'test', '__tests__', 'e2e', 'spec']);

const COMMENT_PREFIXES = ['#', '//', '*', '/*', '"""', "'''"];

const splitLines = (text) => text.split(/\r\n|\r|\n/);
const isComment = (stripped) =>
  COMMENT_PREFIXES.some((p) => stripped.startsWith(p));
const partsOf = (p) => p.split(/[\\/]/).filter(Boolean);

/**
 * Return the frozen-clock idioms present in `text`, in catalog order. A
 * non-empty result suppresses every clock-dependent rule for the whole file --
 * file-wide (not block-scoped) on purpose: a scope-accurate answer needs a real
 * parser, and blackhawk errs toward silence.
 */
export function frozenClockMarkers(text) {
  return FROZEN_CLOCK_MARKERS.filter((marker) => text.includes(marker));
}

/** True when a path looks like a test file by name or containing directory. */
export function isTestFile(filePath) {
  const suffix = path.extname(filePath);
  if (!SUPPORTED_SUFFIXES.includes(suffix)) return false;
  const name = path.basename(filePath);
  const stem = name.slice(0, name.length - suffix.length);
  if (name.includes('.test.') || name.includes('.spec.')) return true;
  if (stem.startsWith('test_') || stem.endsWith('_test')) return true;
  return partsOf(filePath)
    .slice(0, -1)
    .some((part) => TEST_DIRS.has(part));
}

/** Convert an internal finding to its JSON-contract shape (snake_case id). */
export function toJson(f) {
  return {
    file: f.file,
    line: f.line,
    rule_id: f.ruleId,
    severity: f.severity,
    snippet: f.snippet,
    why: f.why,
  };
}

/** Scan source text, returning findings ordered by line then rule id. */
export function scanText(text, file = '<text>') {
  const frozen = frozenClockMarkers(text).length > 0;
  const findings = [];
  splitLines(text).forEach((raw, i) => {
    const stripped = raw.trim();
    if (!stripped || isComment(stripped)) return;
    for (const rule of RULES) {
      if (frozen && rule.clockDependent) continue;
      const match = rule.pattern.exec(stripped);
      if (!match) continue;
      if (rule.keep && !rule.keep(match)) continue;
      findings.push({
        file,
        line: i + 1,
        ruleId: rule.ruleId,
        severity: rule.severity,
        snippet: stripped.slice(0, SNIPPET_LIMIT),
        why: rule.why,
      });
    }
  });
  return findings;
}

/** Scan one file. Unreadable files yield no findings. */
export function scanFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  return scanText(text, filePath);
}

/** Yield the files a path contributes: explicit files win, dirs are filtered. */
function* iterFiles(root) {
  let stat;
  try {
    stat = fs.statSync(root);
  } catch {
    return;
  }
  if (stat.isFile()) {
    if (SUPPORTED_SUFFIXES.includes(path.extname(root))) yield root;
    return;
  }
  const collected = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) collected.push(full);
    }
  };
  walk(root);
  collected.sort();
  for (const f of collected) {
    if (partsOf(f).some((part) => SKIP_DIRS.has(part))) continue;
    if (isTestFile(f)) yield f;
  }
}

/** Scan every given file/directory, de-duplicating overlapping paths. */
export function scanPaths(paths) {
  const seen = new Set();
  const findings = [];
  let scanned = 0;
  for (const entry of paths) {
    for (const filePath of iterFiles(entry)) {
      const resolved = path.resolve(filePath);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      scanned += 1;
      findings.push(...scanFile(filePath));
    }
  }
  findings.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.ruleId.localeCompare(b.ruleId),
  );
  return { findings, filesScanned: scanned };
}
