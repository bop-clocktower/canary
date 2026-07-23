// alarm -- fire only when a deletion removes the last coverage of a hot symbol.
//
// Most test deletions are legitimate, so katana is silent by default and
// records everything. It alarms in exactly one situation: the deleted test was
// the *last* test covering a symbol `critical-areas.json` marks high-risk. When
// that file is missing or malformed the alarm degrades to recording-only and
// says so; a gate that manufactures failures on missing data gets muted, and a
// muted gate is worse than no gate.

import fs from 'node:fs';

import { isTestFile } from './diffscan.mjs';

export const DEGRADED_NOTICE =
  'critical-area data unavailable, recording only, not alarming';

// risk_score at or above this makes a name-matched last-coverage loss CRITICAL;
// below it the loss is still real but ranked HIGH.
const CRITICAL_RISK = 0.7;

// Directory names too generic to imply a coverage relationship on their own.
const GENERIC_DIRS = new Set([
  'src',
  'lib',
  'app',
  'apps',
  'packages',
  'pkg',
  'tests',
  'test',
  '__tests__',
  'e2e',
  'spec',
  'dist',
  'build',
]);

const CODE_SUFFIXES = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py'];

export const Fidelity = {
  NAME_MATCHED: { value: 'name-matched', rank: 0 },
  HEURISTIC: { value: 'heuristic', rank: 1 },
};

export const Severity = {
  CRITICAL: { value: 'critical', sortKey: 0 },
  HIGH: { value: 'high', sortKey: 1 },
  MEDIUM: { value: 'medium', sortKey: 2 },
};

/**
 * @typedef {{available: boolean, areas: Array<Record<string, any>>, reason: string}} CriticalAreas
 */

/** JSON-contract shape of a finding. */
export function findingToDict(f) {
  return {
    kind: f.kind,
    test: f.test,
    file: f.file,
    area: f.area,
    fidelity: f.fidelity.value,
    severity: f.severity.value,
    evidence: f.evidence,
  };
}

/**
 * Load critical-areas.json; unavailable (not throwing) on any problem.
 * @returns {CriticalAreas}
 */
export function loadCriticalAreas(filePath) {
  if (filePath === null || filePath === undefined) {
    return {
      available: false,
      areas: [],
      reason: 'critical-area file not provided',
    };
  }
  if (!fs.existsSync(filePath)) {
    return {
      available: false,
      areas: [],
      reason: `critical-area file not found: ${filePath}`,
    };
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (exc) {
    return {
      available: false,
      areas: [],
      reason: `critical-area file malformed: ${exc.message}`,
    };
  }
  const areas =
    data &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    Array.isArray(data.areas)
      ? data.areas
      : [];
  return { available: true, areas: [...areas], reason: '' };
}

const norm = (text) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Symbols an area path exposes: its basename minus code suffix, plus parts.
 * `src/loyalty/points.service.ts` -> {points.service, points, service}.
 */
export function areaSymbols(areaPath) {
  let base = areaPath.replace(/\\/g, '/').split('/').pop();
  for (const suffix of CODE_SUFFIXES) {
    if (base.endsWith(suffix)) {
      base = base.slice(0, -suffix.length);
      break;
    }
  }
  const symbols = new Set([base]);
  for (const part of base.split('.')) if (part) symbols.add(part);
  return symbols;
}

const areaNormSymbols = (areaPath) => {
  const out = new Set();
  for (const s of areaSymbols(areaPath)) {
    const n = norm(s);
    if (n.length >= 4) out.add(n);
  }
  return out;
};

const dirsOf = (p) => {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(0, -1);
};

const significantDirs = (p) =>
  new Set(dirsOf(p).filter((d) => !GENERIC_DIRS.has(d)));

const nameCovers = (testName, normSymbols) => {
  const normalized = norm(testName);
  return [...normSymbols].some((sym) => normalized.includes(sym));
};

// Heavy/ignored directories never worth walking for test files (#395).
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
  'coverage',
  '.next',
  '.turbo',
]);

/**
 * Enumerate repo test files, pruning heavy dirs. Deterministic (sorted).
 * @returns {[string, string][]} [relPosixPath, absolutePath] pairs.
 */
export function repoTestFiles(repo) {
  const results = [];
  const walk = (absDir, relDir) => {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    const dirs = [];
    const files = [];
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) dirs.push(e.name);
      } else if (e.isFile()) {
        files.push(e.name);
      }
    }
    for (const name of files.sort()) {
      const rel = relDir ? `${relDir}/${name}` : name;
      if (isTestFile(rel)) results.push([rel, `${absDir}/${name}`]);
    }
    for (const name of dirs.sort()) {
      walk(`${absDir}/${name}`, relDir ? `${relDir}/${name}` : name);
    }
  };
  walk(String(repo), '');
  return results;
}

const PY_TEST_DEF = /^\s*(?:async\s+)?def\s+(test\w*)\s*\(/gm;
const JS_TEST_CALL =
  /\b(?:describe|context|it|test)(?:\.\w+)?\s*\(\s*(['"`])(.*?)\1/g;

function testNames(text) {
  const names = [];
  for (const m of text.matchAll(PY_TEST_DEF)) names.push(m[1]);
  for (const m of text.matchAll(JS_TEST_CALL)) names.push(m[2]);
  return names;
}

const readTextSafe = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

function nameCoverageRemains(repo, normSymbols) {
  for (const [, abs] of repoTestFiles(repo)) {
    const text = readTextSafe(abs);
    if (text === null) continue;
    if (testNames(text).some((name) => nameCovers(name, normSymbols)))
      return true;
  }
  return false;
}

function dirCoverageRemains(repo, areaDirs) {
  for (const [rel, abs] of repoTestFiles(repo)) {
    if (!dirsOf(rel).some((d) => areaDirs.has(d))) continue;
    const text = readTextSafe(abs);
    if (text === null) continue;
    if (testNames(text).length) return true;
  }
  return false;
}

/** Return last-coverage-removed findings; empty when data is unavailable. */
export function buildFindings(deletions, areas, repo) {
  if (!areas.available) return []; // silent by default: never alarm on degraded data
  const findings = [];

  for (const deletion of deletions) {
    let best = null;
    for (const area of areas.areas) {
      const areaPath = area.path || '';
      const risk = Number.parseFloat(area.risk_score) || 0.0;
      const normSymbols = areaNormSymbols(areaPath);

      let fidelity;
      let severity;
      if (normSymbols.size && nameCovers(deletion.name, normSymbols)) {
        if (nameCoverageRemains(repo, normSymbols)) continue;
        fidelity = Fidelity.NAME_MATCHED;
        severity = risk >= CRITICAL_RISK ? Severity.CRITICAL : Severity.HIGH;
      } else {
        const areaDirs = significantDirs(areaPath);
        const delDirs = new Set(dirsOf(deletion.file));
        if (![...areaDirs].some((d) => delDirs.has(d))) continue;
        if (dirCoverageRemains(repo, areaDirs)) continue;
        fidelity = Fidelity.HEURISTIC;
        severity = Severity.MEDIUM;
      }

      const candidate = {
        kind: 'last-coverage-removed',
        test: deletion.name,
        file: deletion.file,
        area: areaPath,
        fidelity,
        severity,
        evidence: `${deletion.name} was the last test covering ${areaPath}`,
      };
      // Keep the best candidate per deletion: lower (fidelity.rank, sortKey)
      // wins, element-wise (name-matched outranks heuristic; then severity).
      if (best === null) {
        best = candidate;
      } else {
        const better =
          fidelity.rank !== best.fidelity.rank
            ? fidelity.rank < best.fidelity.rank
            : severity.sortKey < best.severity.sortKey;
        if (better) best = candidate;
      }
    }
    if (best !== null) findings.push(best);
  }

  findings.sort(
    (a, b) =>
      a.severity.sortKey - b.severity.sortKey ||
      a.file.localeCompare(b.file) ||
      a.test.localeCompare(b.test),
  );
  return findings;
}
