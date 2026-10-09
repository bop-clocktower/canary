// testindex -- every test file in the repo, read once: titles and imports.

import fs from 'node:fs';

import { isTestFile } from './diffscan.mjs';
import { importsOf } from './nearby.mjs';

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

/**
 * A lazy accessor for `{rel, names, imports}` per readable test file, so a run
 * that never needs the repo never walks it, and one that does walks it once.
 * A file that cannot be read is skipped, not fatal (#395).
 */
export function testIndex(repo) {
  let index = null;
  return () => {
    if (index !== null) return index;
    index = [];
    for (const [rel, abs] of repoTestFiles(repo)) {
      const text = readTextSafe(abs);
      if (text === null) continue;
      index.push({
        rel,
        names: testNames(text),
        imports: importsOf(rel, text),
      });
    }
    return index;
  };
}
