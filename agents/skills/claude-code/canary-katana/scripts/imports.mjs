// imports -- which modules a test file imports, and whether one is an area.
//
// Read, not resolved: there is no tsconfig or bundler config here, so a bare or
// aliased specifier is matched by its trailing segments. A mock
// (`vi.mock`/`jest.mock`) is not an import: a test that mocks a module does not
// exercise it.

import { dirsOf, moduleKey, stripCodeSuffix } from './nearby.mjs';

// `from '...'`, `import '...'`, `import('...')`, `require('...')`.
const JS_IMPORT = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*(['"])([^'"\n]+)\1/g;
// `from pkg.mod import a, b` / `import *` / `import (a, b)`.
const PY_FROM =
  /^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+\(?([\w\s,*]+)/gm;
// `import a.b.c as x, d  # noqa` -- everything up to a comment.
const PY_IMPORT = /^[ \t]*import[ \t]+([^\n#]+)/gm;
const PY_DOTTED = /^[\w.]+$/;

// Alias roots (`@/x`, `~/x`, `#/x`) and npm scopes (`@acme/x`): neither names
// a directory in the repo, so both are dropped before matching.
const isAliasRoot = (seg) =>
  ['@', '~', '#'].includes(seg) || seg.startsWith('@');

// Source roots a package path skips: `@acme/core/engine` is
// packages/core/src/engine.ts.
const SOURCE_ROOTS = new Set(['src', 'lib']);
const withoutRoots = (segs) => segs.filter((s) => !SOURCE_ROOTS.has(s));

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
  const alias = isAliasRoot(segs[0]);
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
    .filter((n) => /^\w+$/.test(n))
    .map((n) => `${from}${sep}${n}`);
  return [from, ...modules].map((m) => pyImport(rel, m));
}

/** `import a.b as c, d` imports a.b and d. */
const pyPlainImports = (rel, list) =>
  list
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0])
    .filter((d) => PY_DOTTED.test(d))
    .map((d) => pyImport(rel, d));

/** The modules a test file imports, as records `importKind` can match. */
export function importsOf(rel, text) {
  const js = [...text.matchAll(JS_IMPORT)].map((m) => jsImport(rel, m[2]));
  const from = [...text.matchAll(PY_FROM)].flatMap((m) =>
    pyFromImports(rel, m[1], m[2]),
  );
  const plain = [...text.matchAll(PY_IMPORT)].flatMap((m) =>
    pyPlainImports(rel, m[1]),
  );
  return [...js, ...from, ...plain].filter(Boolean);
}

/**
 * Does one import name `key` (exactly, when relative) or end like `tail`?
 * Two trailing segments must agree; one is enough only off an alias root
 * (`@app/engine`), because a single bare segment is a package name.
 */
function matches(imp, key, tail) {
  if (imp.key !== null) return key !== '' && imp.key === key;
  const segs = withoutRoots(imp.segs);
  if (segs.length >= 2 && tail.length >= 2) {
    return (
      segs[segs.length - 1] === tail[tail.length - 1] &&
      segs[segs.length - 2] === tail[tail.length - 2]
    );
  }
  return imp.alias && segs.length === 1 && segs[0] === tail[tail.length - 1];
}

/** The keys an area is imported by: its module, and its directory's index. */
export function importTargets(areaPath) {
  const key = moduleKey(areaPath);
  const dirKey = moduleKey(`${dirsOf(areaPath).join('/')}/index`);
  return {
    key,
    tail: withoutRoots(key.split('/')),
    dirKey: dirKey === key ? '' : dirKey,
    dirTail: dirKey === key ? [] : withoutRoots(dirKey.split('/')),
  };
}

/**
 * How a list of imports reaches the area: 'direct' (its module), 'barrel'
 * (its directory's index, which re-exports it), or null.
 */
export function importKind(imports, ctx) {
  const t = ctx.targets;
  if (imports.some((imp) => matches(imp, t.key, t.tail))) return 'direct';
  if (
    t.dirTail.length &&
    imports.some((imp) => matches(imp, t.dirKey, t.dirTail))
  ) {
    return 'barrel';
  }
  return null;
}
