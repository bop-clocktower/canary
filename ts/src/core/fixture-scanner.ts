/**
 * Project test-fixture / helper symbol scanner — faithful TS port of
 * `agent/core/fixture_scanner.py`.
 *
 * Extracts named exports from files under conventional fixture/helper dirs so
 * downstream generation imports real identifiers. Regex-based, no AST.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const FIXTURE_DIRS = [
  'tests/fixtures',
  'tests/test-utils',
  'tests/helpers',
  'tests/support',
  'test/fixtures',
  'test/test-utils',
  'test/helpers',
  'e2e/fixtures',
  'e2e/helpers',
  '__tests__/fixtures',
  '__tests__/helpers',
  'fixtures',
  'test-utils',
];

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'coverage',
]);

const SUPPORTED_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.py'];
const MAX_FILES = 20;
const MAX_FILE_BYTES = 32_768;
const MAX_SYMBOLS_PER_FILE = 12;

const TS_DECL_RE =
  /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
const TS_NAMED_RE = /^\s*export\s*\{([^}]+)\}/gm;
const PY_DECL_RE = /^(?:def|class)\s+([A-Za-z][\w]*)/gm;

export interface FixtureSymbols {
  byModule: Record<string, string[]>;
  filesScanned: number;
}

export function isEmpty(s: FixtureSymbols): boolean {
  return Object.keys(s.byModule).length === 0;
}

export class FixtureScanner {
  scan(projectRoot = '.'): FixtureSymbols {
    const root = resolve(projectRoot);
    const result: FixtureSymbols = { byModule: {}, filesScanned: 0 };
    if (!existsSync(root)) return result;

    const candidates = this.collectCandidates(root);

    for (const path of candidates) {
      let text = safeRead(path);
      if (text === null) continue;
      if (text.length > MAX_FILE_BYTES) text = text.slice(0, MAX_FILE_BYTES);

      const symbols = path.endsWith('.py')
        ? extractPython(text)
        : extractTs(text);
      if (symbols.length === 0) continue;

      const relPath = relative(root, path).split(/[/\\]/).join('/');
      result.byModule[relPath] = symbols.slice(0, MAX_SYMBOLS_PER_FILE);
      result.filesScanned += 1;
    }

    return result;
  }

  private collectCandidates(root: string): string[] {
    const candidates: string[] = [];
    const seen = new Set<string>();
    for (const rel of FIXTURE_DIRS) {
      const fixtureDir = resolve(root, rel);
      if (!isDir(fixtureDir) || seen.has(fixtureDir)) continue;
      seen.add(fixtureDir);
      for (const path of rglobFilesSorted(fixtureDir)) {
        if (path.split(/[/\\]/).some((part) => IGNORED_DIRS.has(part)))
          continue;
        if (!SUPPORTED_EXTS.some((e) => path.endsWith(e))) continue;
        candidates.push(path);
        if (candidates.length >= MAX_FILES) return candidates;
      }
      if (candidates.length >= MAX_FILES) break;
    }
    return candidates;
  }
}

/** Recursive file list, sorted — mirrors Python's `sorted(dir.rglob("*"))`. */
function rglobFilesSorted(dir: string): string[] {
  const files: string[] = [];
  const walk = (d: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = resolve(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(dir);
  return files.sort(cmp);
}

function extractTs(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (nameRaw: string): void => {
    const name = nameRaw.trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push(name);
  };

  for (const m of text.matchAll(TS_DECL_RE)) add(m[1]!);

  for (const m of text.matchAll(TS_NAMED_RE)) {
    for (const pieceRaw of m[1]!.split(',')) {
      const piece = pieceRaw.trim();
      if (!piece) continue;
      const asIdx = piece.indexOf(' as ');
      if (asIdx !== -1) add(piece.slice(asIdx + 4));
      else add(piece);
    }
  }

  return out;
}

function extractPython(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(PY_DECL_RE)) {
    const name = m[1]!;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}
