// nearby -- where a test sits relative to a critical area (#1242).
//
// A test relates to an area only when it is NEAR it (or imports it, see
// imports.mjs). Near means one of:
//
//   - the area's significant directories and the test's end the same way
//     (`tests/loyalty/` mirrors `src/loyalty/`). A path SUFFIX, not any shared
//     segment: `apps/web/services/` is not near `packages/api/services/`;
//   - for an area whose directories are all generic (`src/engine.ts`), that
//     directory, or a test directory inside or beside it -- never the tree.
//
// STRONGLY near is the area's own directory, its own test directory, or an
// exact mirror of its significant path. Only a strongly-near file named for the
// area is trusted to be the area's own test file (see alarm.mjs, saturation).

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

const isGenericDir = (d) => GENERIC_DIRS.has(d);

/** Under the repo's root `test/` or `tests/` (not a nested one). */
export const inRootTestDir = (p) => ['test', 'tests'].includes(dirsOf(p)[0]);

/** The significant (non-generic) directories of a path, in order. */
export const sigPath = (p) => dirsOf(p).filter((d) => !isGenericDir(d));

export const significantDirs = (p) => new Set(sigPath(p));

/** The module an area is imported as: no code suffix, no trailing /index. */
export const moduleKey = (p) =>
  stripCodeSuffix(toPosix(p))
    .replace(/(^|\/)index$/, '')
    .replace(/^\.\//, '');

/** Does `long` end with every element of `short`, in order? */
const endsWith = (long, short) =>
  short.length > 0 &&
  short.length <= long.length &&
  short.every((s, i) => long[long.length - short.length + i] === s);

const underDir = (dir, prefix) =>
  prefix === '' || dir === prefix || dir.startsWith(`${prefix}/`);

const testDirsIn = (base) =>
  [...TEST_DIR_SEGMENTS].map((t) => (base ? `${base}/${t}` : t));

/** Test directories inside or beside an all-generic area directory. */
function testDirsBeside(areaDirs) {
  const own = areaDirs.join('/');
  const bases = areaDirs.length ? [own, areaDirs.slice(0, -1).join('/')] : [''];
  return bases.flatMap(testDirsIn);
}

/** Is a test file at `rel` near the area (see the header)? */
export function isNear(rel, ctx) {
  if (ctx.sig.length) {
    const sig = sigPath(rel);
    return endsWith(sig, ctx.sig) || endsWith(ctx.sig, sig);
  }
  const dir = dirsOf(rel).join('/');
  if (dir === ctx.dirs.join('/')) return true;
  return testDirsBeside(ctx.dirs).some((prefix) => underDir(dir, prefix));
}

/** The area's own directory, its own test directory, or an exact mirror. */
export function isStronglyNear(rel, ctx) {
  const dir = dirsOf(rel).join('/');
  const own = ctx.dirs.join('/');
  if (dir === own || testDirsIn(own).some((p) => underDir(dir, p))) return true;
  const sig = sigPath(rel);
  return ctx.sig.length > 0 && sig.join('/') === ctx.sig.join('/');
}

/** The name a test file is named for: `engine.award.test.ts` -> engine.award. */
function testStem(rel) {
  const base = toPosix(rel).split('/').pop().toLowerCase();
  return base
    .replace(/\.[^.]+$/, '')
    .replace(/[._-](test|spec)$/, '')
    .replace(/^test_/, '');
}

/**
 * A test file named for the area: its stem is one of the area's stems (the
 * joined basename or its first part) or starts with one and a separator --
 * `engine.test.ts`, `engine-earn.test.ts`, `test_sprocket.py` for
 * `sprocket.service.ts`.
 */
export function ownsTest(rel, ctx) {
  const stem = testStem(rel);
  return ctx.stems.some(
    (s) =>
      stem === s || ['.', '-', '_'].some((sep) => stem.startsWith(s + sep)),
  );
}
