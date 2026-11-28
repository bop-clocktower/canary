// files -- canary-hawk-dove's only filesystem boundary (#618).
//
// A gate's JSON and the ledger are read from, and the ledger appended to, a
// path the caller names. Each must stay inside the realpath of the repository
// root, and no segment of it may be a symlink: a link can point the ledger at
// a file the operator never meant to touch, or a "run" at a secret. Anything
// that is not a regular file is refused by name rather than read. Each check
// returns a short reason, never an exception message, which can quote bytes.

import fs from 'node:fs';
import path from 'node:path';

/** Is `p` strictly inside `root`? */
function within(root, p) {
  const rel = path.relative(root, p);
  const up = rel === '..' || rel.startsWith(`..${path.sep}`);
  return Boolean(rel) && !up && !path.isAbsolute(rel);
}

/**
 * Resolve `rel` under `root`, or the reason it cannot be used. Every segment
 * is `lstat`ed from the root down (never `stat`, which follows a link), so a
 * symlinked parent is caught as surely as a symlinked file. A missing segment
 * ends the walk: nothing below it can be a link yet.
 */
function locate(root, rel) {
  let realRoot;
  try {
    realRoot = fs.realpathSync(path.resolve(root));
  } catch {
    return { reason: 'repository not found' };
  }
  const abs = path.resolve(realRoot, String(rel ?? ''));
  if (!within(realRoot, abs)) return { reason: 'outside the repository' };
  let cur = realRoot;
  for (const seg of path.relative(realRoot, abs).split(path.sep)) {
    cur = path.join(cur, seg);
    const st = fs.lstatSync(cur, { throwIfNoEntry: false });
    if (!st) return { abs, realRoot, exists: false };
    if (st.isSymbolicLink()) return { reason: 'symlink' };
  }
  return { abs, realRoot, exists: true };
}

/** The repository-relative POSIX spelling of `abs`. */
const relOf = (realRoot, abs) =>
  path.relative(realRoot, abs).split(path.sep).join('/');

/**
 * Read one regular file inside `root`.
 *
 * @param {string} root
 * @param {string} rel
 * @param {{ext: string, maxBytes: number}} gate
 * @returns {{text: string, rel: string} | {notRead: string}}
 */
export function readInside(root, rel, { ext, maxBytes }) {
  const where = locate(root, rel);
  if (where.reason) return { notRead: where.reason };
  if (!where.exists) return { notRead: 'missing' };
  const st = fs.statSync(where.abs);
  if (!st.isFile()) return { notRead: 'not a regular file' };
  if (path.extname(where.abs) !== ext) return { notRead: `not a ${ext} file` };
  if (st.size > maxBytes) return { notRead: `larger than ${maxBytes} bytes` };
  return {
    text: fs.readFileSync(where.abs, 'utf8'),
    rel: relOf(where.realRoot, where.abs),
  };
}

/**
 * Append `text` to a regular file inside `root`, creating it and its parents.
 * Never truncates, rewrites or reorders: the ledger is append-only.
 *
 * @returns {string|null} null on success, else a short reason
 */
export function appendInside(root, rel, text) {
  const where = locate(root, rel);
  if (where.reason) return `not written: ${where.reason}`;
  if (where.exists && !fs.statSync(where.abs).isFile()) {
    return 'not written: not a regular file';
  }
  try {
    fs.mkdirSync(path.dirname(where.abs), { recursive: true });
    fs.appendFileSync(where.abs, text, 'utf8');
    return null;
  } catch (exc) {
    return `not written: ${exc.code ?? 'error'}`;
  }
}

/**
 * Write a report to `out` (the sibling skills' `--out` convention).
 *
 * @returns {string|null} null on success, else `cannot write <out>: <code>`
 */
export function writeOut(out, text) {
  try {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, `${text}\n`, 'utf8');
    return null;
  } catch (exc) {
    return `cannot write ${out}: ${exc.code ?? 'error'}`;
  }
}
