// ties -- how katana relates a test file to a critical area (#1242, #1253).
//
// Pure predicates over a test (an index entry {rel, names, imports}, or a
// deletion {file, name} read through the run scope) and an area context from
// areas.mjs. alarm.mjs grades deletions with them; the not-assessed report
// uses the same ones, so "tied", "covers" and "related" mean one thing.

import { CRITICAL_RISK, nameCovers } from './areas.mjs';
import { importKind } from './imports.mjs';
import {
  dirsOf,
  inRootTestDir,
  isNear,
  isStronglyNear,
  ownsTest,
  significantDirs,
} from './nearby.mjs';

/**
 * Is this indexed test file still coverage of the area? It is when it has a
 * test and either imports the area's module, or is near the area and named for
 * it -- whatever its titles say -- or, failing both, is near (or imports the
 * area's directory) and a title names the area's symbol.
 */
export function covers(e, ctx) {
  if (!e.names.length) return false;
  const kind = importKind(e.imports, ctx);
  if (kind === 'direct') return true;
  const near = isNear(e.rel, ctx);
  if (near && ownsTest(e.rel, ctx)) return true;
  return (
    (near || kind === 'barrel') && e.names.some((n) => nameCovers(n, ctx.syms))
  );
}

/**
 * Did the deleted test belong to the area? Its name alone is not enough
 * (#1242 review): the file must be near the area, be named for it, or have
 * imported it.
 */
const belongs = (deletion, ctx, scope) =>
  isNear(deletion.file, ctx) ||
  ownsTest(deletion.file, ctx) ||
  importKind(scope.importsOf(deletion.file), ctx) !== null;

/**
 * Is the deleted test tied to the area for certain? Named for the symbol and
 * belonging to it, or importing its module directly -- a behaviour title
 * ("creates a link ...") over a direct import is still the area's test (#1253).
 */
export const tiedDeletion = (deletion, ctx, scope) =>
  ctx.syms.size > 0 &&
  ((nameCovers(deletion.name, ctx.syms) && belongs(deletion, ctx, scope)) ||
    importKind(scope.importsOf(deletion.file), ctx) === 'direct');

/**
 * Shares a significant directory with the area, or is near it -- or, for a
 * high-risk area only, sits in the root `test/`/`tests/` (#1255): a
 * single-package repo's integration tests live there and share no directory
 * with `src/<dir>/`. Lower-risk areas keep #1246's rule, so a root-tests
 * deletion cannot put every area at stake.
 */
export const related = (deletion, ctx) =>
  isNear(deletion.file, ctx) ||
  dirsOf(deletion.file).some((d) => significantDirs(ctx.path).has(d)) ||
  (ctx.risk >= CRITICAL_RISK && inRootTestDir(deletion.file));

/**
 * Tied to the area for certain: imports its module, or is named for it and sits
 * in its own directory, its own test directory, or an exact mirror. A file
 * merely named for it elsewhere (`apps/web/.../engine-signal.test.tsx`) is not.
 */
export const tiedToArea = (e, ctx) =>
  importKind(e.imports, ctx) === 'direct' ||
  (ownsTest(e.rel, ctx) && isStronglyNear(e.rel, ctx));
