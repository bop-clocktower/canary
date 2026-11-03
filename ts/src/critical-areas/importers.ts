/**
 * Unique-importer counts (#1529). Read, not resolved, as in katana's
 * imports.mjs: an ambiguous suffix counts nothing, so the count is a floor.
 */
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

type Lang = 'js' | 'py' | 'php';

interface Scope {
  files: ReadonlySet<string>;
  /** `<lang>:<path suffix without extension>` to the paths ending so. */
  suffixes: ReadonlyMap<string, string[]>;
}

const JS_FILE = /\.[cm]?[jt]sx?$/;
const JS_SPEC =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"\n]+)['"]/g;
const JS_ALIAS = /^[@~#]\//;
const JS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const JS_MAPPED: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};
const PY_STMT =
  /^[ \t]*(?:from[ \t]+(\.*[\w.]*)[ \t]+import|import[ \t]+([\w., \t]+))/gm;
const PHP_PATH = /\b(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"\n]+)['"]/g;
const PHP_USE = /^[ \t]*use[ \t]+\\?([\w\\]+)/gm;

function langOf(path: string): Lang | null {
  if (path.endsWith('.py')) return 'py';
  if (path.endsWith('.php')) return 'php';
  return JS_FILE.test(path) ? 'js' : null;
}

function buildScope(files: string[]): Scope {
  const suffixes = new Map<string, string[]>();
  for (const file of files) {
    const lang = langOf(file);
    const parts = file.replace(/\.[^./]+$/, '').split('/');
    parts.forEach((_, i) => {
      const key = `${lang}:${parts.slice(i).join('/')}`;
      suffixes.set(key, [...(suffixes.get(key) ?? []), file]);
    });
  }
  return { files: new Set(files), suffixes };
}

const uniqueSuffix = (scope: Scope, lang: Lang, key: string): string | null => {
  const hits = scope.suffixes.get(`${lang}:${key}`) ?? [];
  return hits.length === 1 ? hits[0]! : null;
};

const firstFile = (scope: Scope, names: string[]): string | null =>
  names.find((n) => scope.files.has(n)) ?? null;

function jsCandidates(base: string): string[] {
  const ext = posix.extname(base);
  const mapped = (JS_MAPPED[ext] ?? []).map(
    (e) => base.slice(0, -ext.length) + e,
  );
  return [
    base,
    ...mapped,
    ...JS_EXTS.map((e) => base + e),
    ...JS_EXTS.map((e) => `${base}/index${e}`),
  ];
}

function resolveJs(spec: string, from: string, scope: Scope): string | null {
  if (JS_ALIAS.test(spec)) {
    const key = spec.slice(2).replace(/\.[^./]+$/, '');
    return uniqueSuffix(scope, 'js', key);
  }
  if (!spec.startsWith('.')) return null;
  const base = posix.join(posix.dirname(from), spec);
  return firstFile(scope, jsCandidates(base));
}

function resolvePy(module: string, from: string, scope: Scope): string | null {
  const dots = /^\.*/.exec(module)![0].length;
  const key = module.slice(dots).replaceAll('.', '/');
  if (dots === 0) return uniqueSuffix(scope, 'py', key);
  const up = '../'.repeat(dots - 1);
  const base = posix.join(posix.dirname(from), up, key);
  return firstFile(scope, [`${base}.py`, `${base}/__init__.py`]);
}

function matchesOf(text: string, pattern: RegExp): (string | undefined)[][] {
  return [...text.matchAll(pattern)].map((m) => m.slice(1));
}

function jsTargets(text: string, from: string, scope: Scope) {
  return matchesOf(text, JS_SPEC).map(([spec]) =>
    resolveJs(spec!, from, scope),
  );
}

function pyTargets(text: string, from: string, scope: Scope) {
  return matchesOf(text, PY_STMT).flatMap(([fromModule, imported]) =>
    (fromModule !== undefined ? [fromModule] : imported!.split(','))
      .map((m) => m.trim().split(/\s/)[0]!)
      .map((m) => resolvePy(m, from, scope)),
  );
}

function phpTargets(text: string, from: string, scope: Scope) {
  const paths = matchesOf(text, PHP_PATH).map(([p]) =>
    firstFile(scope, [posix.join(posix.dirname(from), p!)]),
  );
  const uses = matchesOf(text, PHP_USE).map(([u]) =>
    uniqueSuffix(scope, 'php', u!.replaceAll('\\', '/')),
  );
  return [...paths, ...uses];
}

const TARGETS = { js: jsTargets, py: pyTargets, php: phpTargets };

function readSource(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/** Unique non-self importers per file. Pass only non-test sources (D7). */
export function countImporters(
  root: string,
  files: string[],
): Map<string, number> {
  const scope = buildScope(files);
  const counts = new Map(files.map((f) => [f, 0]));
  for (const from of files) {
    const lang = langOf(from);
    const text = readSource(join(root, from));
    if (lang === null || text === null) continue;
    const targets = new Set(TARGETS[lang](text, from, scope));
    for (const target of targets) {
      if (target !== null && target !== from) {
        counts.set(target, counts.get(target)! + 1);
      }
    }
  }
  return counts;
}
