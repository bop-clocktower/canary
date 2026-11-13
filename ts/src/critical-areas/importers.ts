/**
 * Unique-importer counts (#1529). Read, not resolved, as in katana's
 * imports.mjs, so the count is approximate: it can miss an aliased or ambiguous
 * import, and it can count a mention in a string.
 */
import { join, posix } from 'node:path';

import { isPythonStdlibModule } from '../core/vacuity-scanner.js';
import { readRegularFile } from './regular-file.js';
import type { SignalSource } from './scoring.js';

type Lang = 'js' | 'py' | 'php';

export interface ImporterRead {
  /** `null` is unmeasured: no file could be read, so 0 would be a false claim. */
  counts: ReadonlyMap<string, number> | null;
  source: SignalSource;
}

interface Scope {
  files: ReadonlySet<string>;
  /** `<lang>:<path suffix without extension>` to the paths ending so. */
  suffixes: ReadonlyMap<string, string[]>;
}

const JS_FILE = /\.[cm]?[jt]sx?$/;
// No two adjacent runs may match the same character: `\s*\(?\s*` splits a
// run of spaces every way before failing, O(n^2) on a hostile line (#1575).
const JS_SPEC =
  /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]([^'"\n]+)['"]/g;
const JS_ALIAS = /^[@~#]\//;
const JS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const JS_MAPPED: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};
// `[\w.]*` is the same language as `\.*[\w.]*`, without splitting a dot run.
const PY_STMT =
  /^[ \t]*(?:from[ \t]+([\w.]*)[ \t]+import|import[ \t]+([\w., \t]+))/gm;
const PHP_PATH =
  /\b(?:require|include)(?:_once)?\s*(?:\(\s*)?['"]([^'"\n]+)['"]/g;
const PHP_USE = /^[ \t]*use[ \t]+\\?([\w\\]+)/gm;
const COMMENT_LINE: Record<Lang, RegExp> = {
  js: /^\s*(?:\/\/|\/\*|\*)/,
  py: /^\s*#/,
  php: /^\s*(?:#|\/\/|\/\*|\*)/,
};

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
    // Only a code extension: `.service` in `inv.service` is part of the name.
    const key = spec.slice(2).replace(JS_FILE, '');
    return uniqueSuffix(scope, 'js', key);
  }
  if (!spec.startsWith('.')) return null;
  const base = posix.join(posix.dirname(from), spec);
  return firstFile(scope, jsCandidates(base));
}

function resolvePy(module: string, from: string, scope: Scope): string | null {
  const dots = /^\.*/.exec(module)![0].length;
  const key = module.slice(dots).replaceAll('.', '/');
  if (dots === 0) {
    // `import os` names the standard library, even beside a `py/os.py`.
    return isPythonStdlibModule(key.split('/')[0]!)
      ? null
      : uniqueSuffix(scope, 'py', key);
  }
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

const withoutCommentLines = (text: string, lang: Lang): string =>
  text
    .split('\n')
    .filter((line) => !COMMENT_LINE[lang].test(line))
    .join('\n');

/** Unread importers make a count a lower bound, so `measured` must not say so. */
function sourceOf(total: number, unread: number): SignalSource {
  const counted = { files_read: total - unread, files_unread: unread };
  if (unread === 0) return { status: 'measured', ...counted };
  return unread === total
    ? {
        status: 'absent',
        reason: `read 0 of ${total} source file(s) from the working tree`,
        ...counted,
      }
    : {
        status: 'partial',
        reason: `could not read ${unread} of ${total} source file(s) from the working tree, so importer counts are a lower bound`,
        ...counted,
      };
}

/**
 * Unique non-self importers per file. Only `files` act as importers, so pass
 * only non-test sources (D7). `extraTargets` can be imported but import nothing,
 * and resolve in their own scope: naming one must not make a suffix ambiguous
 * and so change a count in `files`.
 */
export function countImporters(
  root: string,
  files: string[],
  extraTargets: string[] = [],
): ImporterRead {
  const scope = buildScope(files);
  const widerScope = buildScope([...files, ...extraTargets]);
  const extras = new Set(extraTargets);
  const counts = new Map([...files, ...extraTargets].map((f) => [f, 0]));
  let unread = 0;
  for (const from of files) {
    const lang = langOf(from);
    const text = readRegularFile(join(root, from));
    if (text === null) unread += 1;
    if (lang === null || text === null) continue;
    const code = withoutCommentLines(text, lang);
    const targets = new Set([
      ...TARGETS[lang](code, from, scope),
      ...TARGETS[lang](code, from, widerScope).filter(
        (t) => t !== null && extras.has(t),
      ),
    ]);
    for (const target of targets) {
      if (target !== null && target !== from) {
        counts.set(target, counts.get(target)! + 1);
      }
    }
  }
  const nothingRead = files.length > 0 && unread === files.length;
  return {
    counts: nothingRead ? null : counts,
    source: sourceOf(files.length, unread),
  };
}
