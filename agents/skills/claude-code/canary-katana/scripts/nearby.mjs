// nearby -- where a test sits relative to a critical area (#1242).
//
// A remaining test keeps an area covered only when it is NEAR the area: under
// the area's deepest significant directory, in a test directory inside or
// beside an all-generic one (`src/__tests__/`, `tests/`), or anywhere if it
// imports the area's module. A bare name match across the whole repo used to
// count, so an area named for a common word was always "covered".

import { TEST_DIR_SEGMENTS } from './diffscan.mjs';

const CODE_SUFFIXES = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py'];

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

export const toPosix = (p) => p.replace(/\\/g, '/');

export const stripCodeSuffix = (name) => {
  for (const suffix of CODE_SUFFIXES) {
    if (name.endsWith(suffix)) return name.slice(0, -suffix.length);
  }
  return name;
};

export const dirsOf = (p) => toPosix(p).split('/').filter(Boolean).slice(0, -1);

export const isGenericDir = (d) => GENERIC_DIRS.has(d);

export const significantDirs = (p) =>
  new Set(dirsOf(p).filter((d) => !isGenericDir(d)));

/** The module an area is imported as: no code suffix, no trailing /index. */
export const moduleKey = (p) =>
  stripCodeSuffix(toPosix(p))
    .replace(/\/index$/, '')
    .replace(/^\.\//, '');

/** The name a test file is named for: `engine.award.test.ts` -> engine.award. */
function testStem(rel) {
  const base = toPosix(rel).split('/').pop().toLowerCase();
  return base
    .replace(/\.[^.]+$/, '')
    .replace(/[._-](test|spec)$/, '')
    .replace(/^test_/, '');
}

const underDir = (dir, prefix) =>
  prefix === '' || dir === prefix || dir.startsWith(`${prefix}/`);

/** Test directories inside or beside an all-generic area directory. */
function testDirsBeside(areaDirs) {
  const own = areaDirs.join('/');
  const bases = areaDirs.length ? [own, areaDirs.slice(0, -1).join('/')] : [''];
  return bases.flatMap((base) =>
    [...TEST_DIR_SEGMENTS].map((t) => (base ? `${base}/${t}` : t)),
  );
}

/**
 * Is a test file at `rel` near the area? Under its deepest significant
 * directory wherever that name appears (so `tests/loyalty/` mirrors
 * `src/loyalty/`); or, for an area whose directories are all generic, in that
 * directory or a test directory inside or beside it -- never the whole tree.
 */
export function isNear(rel, ctx) {
  const dirs = dirsOf(rel);
  if (ctx.anchor !== null) return dirs.includes(ctx.anchor);
  const dir = dirs.join('/');
  if (dir === ctx.dirs.join('/')) return true;
  return testDirsBeside(ctx.dirs).some((prefix) => underDir(dir, prefix));
}

/** A test file named for the area: `engine.test.ts`, `engine-earn.test.ts`. */
export function ownsTest(rel, ctx) {
  if (!ctx.stem) return false;
  const stem = testStem(rel);
  return (
    stem === ctx.stem ||
    ['.', '-', '_'].some((s) => stem.startsWith(ctx.stem + s))
  );
}

// `from '...'`, `import '...'`, `import('...')`, `require('...')`. A mock is
// not an import: a test that mocks a module does not exercise it.
const JS_IMPORT = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*(['"])([^'"\n]+)\1/g;
const PY_FROM = /^\s*from\s+(\.*[\w.]*)\s+import\s+\(?([\w\s,]+)/gm;
const PY_IMPORT = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)\s*$/gm;
const ALIAS_ROOTS = new Set(['@', '~', '#']);

/** Resolve `parts` against `dirSegs`; null when it climbs out of the repo. */
function resolveSegs(dirSegs, parts) {
  const out = [...dirSegs];
  for (const part of parts) {
    if (part === '..') {
      if (!out.length) return null;
      out.pop();
    } else if (part !== '' && part !== '.') {
      out.push(part);
    }
  }
  return out;
}

/** One import record: an exact repo module `key`, or a tail of `segs`. */
function jsImport(rel, spec) {
  if (spec === '.' || spec === '..' || /^\.\.?\//.test(spec)) {
    const segs = resolveSegs(dirsOf(rel), spec.split('/'));
    return segs ? { key: moduleKey(segs.join('/')), segs: null } : null;
  }
  const segs = spec.split('/').filter(Boolean);
  if (!segs.length) return null;
  segs[segs.length - 1] = stripCodeSuffix(segs[segs.length - 1]);
  const alias = ALIAS_ROOTS.has(segs[0]);
  return { key: null, segs: alias ? segs.slice(1) : segs, alias };
}

/** A python module path; leading dots are relative to the test's package. */
function pyImport(rel, dotted) {
  const lead = /^\.*/.exec(dotted)[0].length;
  const segs = dotted.slice(lead).split('.').filter(Boolean);
  if (lead === 0) return { key: null, segs, alias: false };
  const dirs = dirsOf(rel);
  const base = dirs.slice(0, dirs.length - (lead - 1));
  return { key: [...base, ...segs].join('/'), segs: null };
}

/** `from pkg import a, b` imports pkg, pkg.a and pkg.b (a may be a module). */
function pyFromImports(rel, from, names) {
  const sep = from.endsWith('.') ? '' : '.';
  const modules = names
    .split(',')
    .map((n) => n.trim().split(/\s+/)[0])
    .filter(Boolean)
    .map((n) => `${from}${sep}${n}`);
  return [from, ...modules].map((m) => pyImport(rel, m));
}

/** The modules a test file imports, as records `importsArea` can match. */
export function importsOf(rel, text) {
  const js = [...text.matchAll(JS_IMPORT)].map((m) => jsImport(rel, m[2]));
  const from = [...text.matchAll(PY_FROM)].flatMap((m) =>
    pyFromImports(rel, m[1], m[2]),
  );
  const plain = [...text.matchAll(PY_IMPORT)].flatMap((m) =>
    m[1].split(',').map((d) => pyImport(rel, d.trim())),
  );
  return [...js, ...from, ...plain].filter(Boolean);
}

/**
 * Does an import name the area's module? Relative imports resolve exactly. A
 * bare or aliased specifier cannot be resolved without the consumer's config,
 * so it matches on its last two segments (`@app/pricing/engine` ->
 * pricing/engine); a single bare segment is a package name and never matches,
 * unless it hangs off an alias root (`@/engine`).
 */
function importsArea(imp, ctx) {
  if (imp.key !== null) return imp.key === ctx.key;
  const { segs } = imp;
  const k = ctx.keySegs;
  if (segs.length >= 2 && k.length >= 2) {
    return (
      segs[segs.length - 1] === k[k.length - 1] &&
      segs[segs.length - 2] === k[k.length - 2]
    );
  }
  return imp.alias && segs.length === 1 && segs[0] === k[k.length - 1];
}

/** Does an indexed test file import the area? */
export const importsAny = (entry, ctx) =>
  entry.imports.some((imp) => importsArea(imp, ctx));
