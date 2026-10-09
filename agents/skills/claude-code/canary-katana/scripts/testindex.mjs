// testindex -- every test file in the repo, read once: titles and imports.

import fs from 'node:fs';

import { isTestFile } from './diffscan.mjs';
import { importsOf } from './imports.mjs';

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
function testIndex(repo) {
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

const stripAb = (p) =>
  p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;

/** The text of every file a diff touches, from its hunk lines on both sides. */
function diffFileTexts(diff) {
  const texts = new Map();
  let minus = null;
  let file = null;
  for (const raw of String(diff).split('\n')) {
    if (raw.startsWith('diff --git')) file = minus = null;
    else if (raw.startsWith('--- ')) minus = stripAb(raw.slice(4).trim());
    else if (raw.startsWith('+++ ')) {
      const plus = stripAb(raw.slice(4).trim());
      file = plus === '/dev/null' ? minus : plus;
    } else if (file && /^[-+ ]/.test(raw)) {
      texts.set(file, `${texts.get(file) ?? ''}${raw.slice(1)}\n`);
    }
  }
  return texts;
}

/**
 * Imports per file as the diff shows them, so a deleted test file -- gone from
 * disk -- can still be tied to the area it imported.
 */
function diffImports(diff) {
  const out = new Map();
  for (const [file, text] of diffFileTexts(diff)) {
    out.set(file, importsOf(file, text));
  }
  return out;
}

/**
 * What the run can see: the repo's test files (lazily), and each touched
 * file's imports -- from the diff when it carries the file (a deleted file is
 * gone from disk), else from disk.
 */
export function scopeOf(repo, diff) {
  const index = testIndex(repo);
  const fromDiff = diffImports(diff);
  return {
    index,
    importsOf: (file) =>
      fromDiff.get(file) ?? index().find((e) => e.rel === file)?.imports ?? [],
  };
}
