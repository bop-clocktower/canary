// Tier-1 static scanner: test sources -> shared-state suspect findings (pure).
//
// AST-lite by design -- no test execution, no parser dependency, standard
// library only -- so it ships wherever node does and runs cheaply on every PR.
// Two rules (SV001, SV002) need whole-file context, so the scan is two-pass: a
// file-level pass for those, plus a line pass for the local rules (SV003,
// SV004). See SKILL.md for the fidelity limits this buys.

import fs from 'node:fs';
import path from 'node:path';

import {
  SEVERITY,
  WHY,
  SV003_PATTERN,
  SV004_PATTERN,
  PYTHON_SETUP_TEARDOWN,
  JS_SETUP_TEARDOWN,
  PY_MODULE_MUTABLE,
  JS_MODULE_MUTABLE,
  mutationPattern,
} from './rules.mjs';

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

/** @returns {string[]} the path's components, separator-agnostic. */
const partsOf = (p) => p.split(/[\\/]/).filter(Boolean);

/** True when a path looks like a test file by name or containing directory. */
export function isTestFile(filePath) {
  const suffix = path.extname(filePath);
  if (!SUPPORTED_SUFFIXES.includes(suffix)) return false;
  const name = path.basename(filePath);
  const stem = name.slice(0, name.length - suffix.length);
  if (name.includes('.test.') || name.includes('.spec.')) return true;
  if (stem.startsWith('test_') || stem.endsWith('_test')) return true;
  const dirs = partsOf(filePath).slice(0, -1);
  return dirs.some((part) => TEST_DIRS.has(part));
}

function makeFinding(file, line, ruleId, snippet) {
  return {
    file,
    line,
    ruleId,
    severity: SEVERITY[ruleId],
    snippet: snippet.slice(0, SNIPPET_LIMIT),
    why: WHY[ruleId],
  };
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

/** Module-level mutable declarations that some line later mutates in place. */
function sv001ModuleMutables(lines, file, isPy, text) {
  const declRe = isPy ? PY_MODULE_MUTABLE : JS_MODULE_MUTABLE;
  const findings = [];
  lines.forEach((raw, i) => {
    // Module scope == column 0 (unindented). A mutable declared inside a
    // function is local and cannot leak between tests.
    if (/^\s/.test(raw)) return;
    const match = declRe.exec(raw.trim());
    if (!match) return;
    const name = match[1];
    if (mutationPattern(name).test(text)) {
      findings.push(
        makeFinding(file, i + 1, 'SV001-module-mutable-global', raw.trim()),
      );
    }
  });
  return findings;
}

/** Setup markers whose matching teardown is absent from the file. */
function sv002MissingTeardown(lines, file, isPy, text) {
  const pairs = isPy ? PYTHON_SETUP_TEARDOWN : JS_SETUP_TEARDOWN;
  const findings = [];
  for (const [setup, teardown] of pairs) {
    if (text.includes(teardown)) continue;
    for (let i = 0; i < lines.length; i += 1) {
      const stripped = lines[i].trim();
      if (isComment(stripped)) continue;
      const hit = isPy
        ? stripped.includes(`def ${setup}`)
        : stripped.startsWith(`${setup}(`) || stripped.includes(` ${setup}(`);
      if (hit) {
        findings.push(
          makeFinding(file, i + 1, 'SV002-missing-teardown', stripped),
        );
        break; // one finding per unmatched setup marker
      }
    }
  }
  return findings;
}

/** Scan source text, returning findings ordered by line then rule id. */
export function scanText(text, file = '<text>') {
  const isPy = file.endsWith('.py');
  const lines = splitLines(text);
  const findings = [];

  findings.push(...sv001ModuleMutables(lines, file, isPy, text));
  findings.push(...sv002MissingTeardown(lines, file, isPy, text));

  lines.forEach((raw, i) => {
    const stripped = raw.trim();
    if (!stripped) return;
    // SV004 is self-reported ordering: it fires on comments and code alike.
    if (SV004_PATTERN.test(stripped)) {
      findings.push(
        makeFinding(file, i + 1, 'SV004-order-coupled-name', stripped),
      );
    }
    if (isComment(stripped)) return;
    if (SV003_PATTERN.test(stripped)) {
      findings.push(
        makeFinding(file, i + 1, 'SV003-shared-singleton-mutation', stripped),
      );
    }
  });

  findings.sort((a, b) => a.line - b.line || a.ruleId.localeCompare(b.ruleId));
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
      const full = path.join(dir, entry.name);
      if (SKIP_DIRS.has(entry.name)) continue;
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
