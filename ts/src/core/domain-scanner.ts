/**
 * Domain knowledge scanner — faithful TS port of
 * `agent/core/domain_scanner.py`.
 *
 * Scans a project's source files (not test files) to extract components, public
 * functions, and API routes. Regex-based, no AST. Pure filesystem reads.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';

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
  '.harness',
  'tests',
  'test',
  '__tests__',
  'spec',
  'coverage',
]);

const TEST_FILE_RE = /(^test_|_test\.py$|\.spec\.|\.test\.)/i;

const MAX_SOURCE_FILES = 20;
const MAX_FILE_BYTES = 32_768;
const MAX_ITEMS = 15;

const PY_EXTS = ['.py'];
const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx'];

export interface DomainContext {
  sourceFiles: number;
  modules: string[];
  components: string[];
  functions: string[];
  apiRoutes: string[];
}

export function isEmpty(ctx: DomainContext): boolean {
  return ctx.sourceFiles === 0;
}

function emptyContext(): DomainContext {
  return {
    sourceFiles: 0,
    modules: [],
    components: [],
    functions: [],
    apiRoutes: [],
  };
}

export class DomainScanner {
  scan(projectRoot = '.'): DomainContext {
    const root = resolve(projectRoot);
    const all = walkSourceFiles(root);
    const pyFiles = all.filter((p) => p.endsWith('.py')).sort(cmp);
    const jsFiles = all
      .filter((p) => JS_EXTS.some((e) => p.endsWith(e)))
      .sort(cmp);
    const files = [...pyFiles, ...jsFiles].slice(0, MAX_SOURCE_FILES);

    if (files.length === 0) return emptyContext();

    const ctx = emptyContext();
    ctx.sourceFiles = files.length;
    ctx.modules = deriveModules(root, files);

    for (const path of files) {
      const text = safeRead(path);
      if (text === null) continue;
      if (path.endsWith('.py')) extractPython(text, ctx);
      else extractJs(text, ctx);
    }

    ctx.components = dedupCap(ctx.components);
    ctx.functions = dedupCap(ctx.functions);
    ctx.apiRoutes = dedupCap(ctx.apiRoutes);
    return ctx;
  }
}

function walkSourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile()) {
        if (!isSourceExt(entry.name)) continue;
        // Faithful to Python: reject if ANY segment of the absolute path is an
        // ignored dir — this includes ancestors above the scan root, not just
        // dirs skipped during the walk.
        if (hasIgnoredSegment(full)) continue;
        if (TEST_FILE_RE.test(entry.name)) continue;
        if (oversized(full)) continue;
        found.push(full);
      }
    }
  };
  walk(root);
  return found;
}

function isSourceExt(name: string): boolean {
  return [...PY_EXTS, ...JS_EXTS].some((e) => name.endsWith(e));
}

function hasIgnoredSegment(absPath: string): boolean {
  return absPath.split(/[/\\]/).some((seg) => IGNORED_DIRS.has(seg));
}

function oversized(path: string): boolean {
  try {
    return statSync(path).size > MAX_FILE_BYTES;
  } catch {
    return true;
  }
}

function deriveModules(root: string, files: string[]): string[] {
  const modules: string[] = [];
  for (const path of files) {
    const rel = relative(root, path);
    if (rel.startsWith('..')) continue;
    const parts = rel.split(/[/\\]/);
    parts[parts.length - 1] = parts[parts.length - 1]!.replace(
      /\.(py|tsx?|jsx?)$/,
      '',
    );
    if (parts[parts.length - 1] === '__init__') parts.pop();
    if (parts.length > 0) modules.push(parts.join('/'));
  }
  return modules.slice(0, MAX_ITEMS);
}

function extractPython(text: string, ctx: DomainContext): void {
  for (const m of text.matchAll(/^class\s+([A-Za-z]\w*)/gm)) {
    ctx.components.push(m[1]!);
  }
  for (const m of text.matchAll(/^def\s+([a-z]\w*)\s*\(/gm)) {
    const name = m[1]!;
    if (!name.startsWith('_')) ctx.functions.push(name);
  }
  const routeRe =
    /@(?:app|router|bp)\.(get|post|put|patch|delete|route)\s*\(\s*['"]([^'"]+)['"]/gi;
  for (const m of text.matchAll(routeRe)) {
    const method = m[1]!.toUpperCase();
    const pathVal = m[2]!;
    ctx.apiRoutes.push(method === 'ROUTE' ? pathVal : `${method} ${pathVal}`);
  }
}

function extractJs(text: string, ctx: DomainContext): void {
  extractJsClasses(text, ctx);
  extractJsCallables(text, ctx);
  extractJsRoutes(text, ctx);
}

function extractJsClasses(text: string, ctx: DomainContext): void {
  for (const m of text.matchAll(
    /\bexport\s+(?:default\s+)?class\s+([A-Za-z]\w*)/g,
  )) {
    ctx.components.push(m[1]!);
  }
}

function extractJsCallables(text: string, ctx: DomainContext): void {
  for (const m of text.matchAll(
    /\bexport\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z]\w*)/g,
  )) {
    pushNamed(ctx, m[1]!);
  }
  for (const m of text.matchAll(
    /\bexport\s+const\s+([A-Za-z]\w*)\s*(?::[^=]+)?\s*=/g,
  )) {
    pushNamed(ctx, m[1]!);
  }
}

function extractJsRoutes(text: string, ctx: DomainContext): void {
  const routeRe =
    /\b(?:router|app)\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/gi;
  for (const m of text.matchAll(routeRe)) {
    ctx.apiRoutes.push(`${m[1]!.toUpperCase()} ${m[2]!}`);
  }
}

/** PascalCase → component; else function (matches the Python heuristic). */
function pushNamed(ctx: DomainContext, name: string): void {
  if (name[0] === name[0]!.toUpperCase() && /[A-Z]/.test(name[0]!)) {
    ctx.components.push(name);
  } else {
    ctx.functions.push(name);
  }
}

function dedupCap(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
    if (result.length >= MAX_ITEMS) break;
  }
  return result;
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
