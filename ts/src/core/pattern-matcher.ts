/**
 * Pattern matcher — extracts a project's existing test conventions.
 *
 * Faithful TypeScript port of `agent/core/pattern_matcher.py`. Scans a project
 * for existing test files and summarises naming/import/assertion conventions so
 * generated tests match. Uses a dependency-free recursive walk with the same
 * glob tails and ignore-dir set as the Python original.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const FILE_PATTERNS: Record<string, string[]> = {
  playwright: ['**/*.spec.ts', '**/*.spec.js', '**/*.test.ts', '**/*.test.js'],
  vitest: ['**/*.test.ts', '**/*.test.js', '**/*.spec.ts', '**/*.spec.js'],
  pytest: ['**/test_*.py', '**/*_test.py'],
  k6: ['**/*.load.js', '**/load.js'],
  e2e_ui: ['**/*.spec.ts', '**/*.spec.js'],
  frontend_unit: ['**/*.test.ts', '**/*.test.js'],
  api: ['**/test_*.py', '**/*_test.py'],
  performance: ['**/*.load.js'],
  python_unit: ['**/test_*.py', '**/*_test.py'],
};
const DEFAULT_PATTERNS = ['**/test_*.py', '**/*.spec.ts', '**/*.test.ts'];
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
]);
const MAX_FILES = 10;
const MAX_FILE_BYTES = 32_768;

export interface PatternProfile {
  test_count: number;
  language: string;
  naming_style: string;
  assertion_style: string;
  uses_classes: boolean;
  uses_fixtures: boolean;
  uses_describe: boolean;
  common_imports: string[];
  sample_names: string[];
}

function emptyProfile(): PatternProfile {
  return {
    test_count: 0,
    language: '',
    naming_style: '',
    assertion_style: '',
    uses_classes: false,
    uses_fixtures: false,
    uses_describe: false,
    common_imports: [],
    sample_names: [],
  };
}

/** Convert a recursive-glob pattern to a basename regex (`*` becomes `[^/]*`). */
function tailRegex(pattern: string): RegExp {
  const tail = pattern.replace(/^\*\*\//, '');
  const body = tail
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*');
  return new RegExp(`^${body}$`);
}

/** `Counter.most_common(n)`: count desc, ties in first-seen order. */
function mostCommon(items: string[], n: number): string[] {
  const counts = new Map<string, number>();
  for (const it of items) counts.set(it, (counts.get(it) ?? 0) + 1);
  return [...counts.entries()]
    .map(([key], i) => ({ key, count: counts.get(key)!, i }))
    .sort((a, b) => b.count - a.count || a.i - b.i)
    .slice(0, n)
    .map((e) => e.key);
}

function walk(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name)) continue;
      walk(join(dir, e.name), out);
    } else if (e.isFile()) {
      out.push(join(dir, e.name));
    }
  }
}

function findTestFiles(
  root: string,
  framework: string,
  testType: string,
): string[] {
  const patterns =
    FILE_PATTERNS[framework] ?? FILE_PATTERNS[testType] ?? DEFAULT_PATTERNS;
  const regexes = patterns.map(tailRegex);
  const all: string[] = [];
  walk(root, all);

  const found: string[] = [];
  const seen = new Set<string>();
  for (const path of all) {
    const base = path.slice(path.lastIndexOf('/') + 1);
    if (!regexes.some((re) => re.test(base))) continue;
    if (seen.has(path)) continue;
    try {
      if (statSync(path).size > MAX_FILE_BYTES) continue;
    } catch {
      continue;
    }
    seen.add(path);
    found.push(path);
  }
  return found.sort();
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

// --- Python analysis -------------------------------------------------------

const PY_IMPORT = /^(?:from\s+([\w.]+)\s+import|import\s+([\w.,\s]+))/gm;
const PY_TEST_FN = /^\s*def\s+(test_\w+)/gm;
const PY_CLASS = /^\s*class\s+Test\w+/m;
const PY_FIXTURE = /@pytest\.fixture|conftest/;

function pythonNamingStyle(names: string[], usesClasses: boolean): string {
  if (names.length === 0) {
    return `${usesClasses ? 'class-based' : 'function-based'} pytest tests`;
  }
  const bodies = names
    .filter((n) => n.startsWith('test_'))
    .map((n) => n.slice('test_'.length));
  const should = bodies.filter((b) => b.startsWith('should_')).length;
  const when = bodies.filter((b) => b.startsWith('when_')).length;
  const raises = bodies.filter(
    (b) => b.includes('raises') || b.includes('error'),
  ).length;

  let pattern = 'test_<action>_<result> convention';
  if (should > Math.floor(bodies.length / 2))
    pattern = 'test_should_* convention';
  else if (when > Math.floor(bodies.length / 2))
    pattern = 'test_when_* convention';
  else if (raises > Math.floor(bodies.length / 3))
    pattern = 'test_<action>_raises_* convention';

  return `${usesClasses ? 'class-based' : 'function-based'} pytest, ${pattern}`;
}

function parsePyImports(text: string): string[] {
  const mods: string[] = [];
  for (const m of text.matchAll(PY_IMPORT)) {
    const mod = (m[1] || m[2] || '').split(/\s+/)[0]!.replace(/,$/, '');
    if (mod) mods.push(mod);
  }
  return mods;
}

function analyzePython(files: string[], profile: PatternProfile): void {
  const imports: string[] = [];
  const funcNames: string[] = [];
  let hasClasses = false;
  let hasFixtures = false;

  for (const path of files) {
    const text = readText(path);
    if (text === null) continue;
    imports.push(...parsePyImports(text));
    for (const m of text.matchAll(PY_TEST_FN)) funcNames.push(m[1]!);
    if (PY_CLASS.test(text)) hasClasses = true;
    if (PY_FIXTURE.test(text)) hasFixtures = true;
  }

  profile.uses_classes = hasClasses;
  profile.uses_fixtures = hasFixtures;
  profile.common_imports = mostCommon(imports, 8);
  profile.sample_names = funcNames.slice(0, 5);
  profile.naming_style = pythonNamingStyle(funcNames, hasClasses);
  profile.assertion_style = hasClasses
    ? 'unittest self.assert* methods'
    : 'pytest assert statements';
}

// --- JS / TS analysis ------------------------------------------------------

const JS_IMPORT = /^import\s+.*?\s+from\s+['"]([^'"]+)['"]/gm;
const JS_REQUIRE = /require\(['"]([^'"]+)['"]\)/g;
const JS_DESCRIBE = /\bdescribe\s*\(/;
const JS_TEST_NAME = /\b(?:it|test)\s*\(\s*['"]([^'"]{3,60})['"]/g;

function jsNamingStyle(names: string[], usesDescribe: boolean): string {
  const structure = usesDescribe
    ? 'describe/it blocks'
    : 'top-level test() calls';
  if (names.length === 0) return structure;
  const should = names.filter((n) =>
    n.toLowerCase().startsWith('should'),
  ).length;
  const sentence = names.filter((n) => /^[A-Z]/.test(n)).length;
  let style = 'imperative names';
  if (should > Math.floor(names.length / 2)) style = 'should-style names';
  else if (sentence > Math.floor(names.length / 2))
    style = 'sentence-style names';
  return `${structure}, ${style}`;
}

function jsAssertionStyle(imports: string[]): string {
  const relevant = imports.filter(
    (i) => i.includes('expect') || i.includes('chai') || i.includes('assert'),
  );
  if (relevant.some((i) => i.includes('chai'))) return 'chai expect assertions';
  if (relevant.some((i) => i.includes('assert')))
    return 'assert-style assertions';
  return 'expect().toBe() / toEqual() assertions';
}

function analyzeJs(files: string[], profile: PatternProfile): void {
  const imports: string[] = [];
  const testNames: string[] = [];
  let hasDescribe = false;

  for (const path of files) {
    const text = readText(path);
    if (text === null) continue;
    for (const m of text.matchAll(JS_IMPORT)) imports.push(m[1]!);
    for (const m of text.matchAll(JS_REQUIRE)) imports.push(m[1]!);
    if (JS_DESCRIBE.test(text)) hasDescribe = true;
    for (const m of text.matchAll(JS_TEST_NAME)) testNames.push(m[1]!);
  }

  profile.uses_describe = hasDescribe;
  profile.common_imports = mostCommon(imports, 8);
  profile.sample_names = testNames.slice(0, 5);
  profile.naming_style = jsNamingStyle(testNames, hasDescribe);
  profile.assertion_style = jsAssertionStyle([...new Set(imports)]);
}

export function isEmpty(profile: PatternProfile): boolean {
  return profile.test_count === 0;
}

export class PatternMatcher {
  scan(projectRoot = '.', framework = '', testType = ''): PatternProfile {
    const root = resolve(projectRoot);
    const files = findTestFiles(root, framework, testType);
    if (files.length === 0) return emptyProfile();

    const sample = files.slice(0, MAX_FILES);
    let isPython =
      framework === 'pytest' ||
      testType === 'api' ||
      testType === 'python_unit';
    if (!isPython && sample.length > 0)
      isPython = extname(sample[0]!) === '.py';

    const profile = emptyProfile();
    profile.test_count = files.length;
    profile.language = isPython ? 'python' : 'javascript';
    if (isPython) analyzePython(sample, profile);
    else analyzeJs(sample, profile);
    return profile;
  }
}
