// read -- bounded, contained reads of every input canary-batgirl scores
// (spec D9, Security).
//
// Every result is tagged, never thrown, so the caller decides what each case
// means for its dimension:
//
//   missing     the path does not exist
//   unreadable  outside the working directory, or not a regular file
//   not-read    a symlink, or over a limit: deliberately not read
//   invalid     read, but not valid JSON
//   ok          `value` holds the text, the parsed JSON, or a file list
//
// CONTAINMENT. Every path, the operator's own and each directory entry, must
// resolve strictly inside the working directory (`root`), and no segment
// below the root may be a symlink: each is `lstat`ed from the root down, never
// `stat`ed, because a symlinked parent reaches the same place a symlinked
// file does. A realpath check then confirms the read stays under the
// realpath'd root. Same convention as canary-unquarantine (`within` in
// markers.mjs, `symlinkOnPath` in git.mjs).
//
// NO CONTENT IN ERRORS. A JSON parse error is reported by name and position
// only: the parser's own message quotes the bytes it failed on. A filesystem
// error is reported by its code.
//
// BOUNDS. An input over a limit is not read at all: a value computed from its
// first N rows would misrepresent the whole, and the bound keeps every later
// scan linear in a size batgirl chose.

import fs from 'node:fs';
import path from 'node:path';

/** Hard bounds on what one run reads. Printed in the reason when hit. */
export const LIMITS = Object.freeze({
  bytes: 32 * 1024 * 1024,
  entries: 100_000,
  lines: 200_000,
  files: 500,
});

const SYMLINK = { kind: 'not-read', reason: 'not read: symlink' };
const OUTSIDE = { kind: 'unreadable', reason: 'outside the working directory' };
const NOT_REGULAR = { kind: 'unreadable', reason: 'not a regular file' };

const cannot = (exc) => ({
  kind: 'unreadable',
  reason: `cannot read: ${exc.code ?? exc.name}`,
});

/** `p` relative to `base` when it is `base` or inside it; null otherwise. */
function within(base, p) {
  const rel = path.relative(base, p);
  const up = rel === '..' || rel.startsWith(`..${path.sep}`);
  return up || path.isAbsolute(rel) ? null : rel;
}

/** Whether a segment of `rel` below `root` is a symlink; null if missing. */
function symlinkOnPath(root, rel) {
  let cur = root;
  for (const seg of rel.split(path.sep).filter(Boolean)) {
    cur = path.join(cur, seg);
    const st = fs.lstatSync(cur, { throwIfNoEntry: false });
    if (!st) return null;
    if (st.isSymbolicLink()) return true;
  }
  return false;
}

/**
 * Resolve `file` against `root` and judge it before anything is read.
 *
 * @returns {{abs: string, stat: fs.Stats} | {result: object}}
 */
function locate(file, root) {
  try {
    const base = path.resolve(root);
    const abs = path.resolve(base, String(file));
    const rel = within(base, abs);
    if (rel === null) return { result: OUTSIDE };
    const link = symlinkOnPath(base, rel);
    if (link === null) return { result: { kind: 'missing' } };
    if (link) return { result: SYMLINK };
    if (within(fs.realpathSync(base), fs.realpathSync(abs)) === null) {
      return { result: SYMLINK };
    }
    return { abs, stat: fs.lstatSync(abs) };
  } catch (exc) {
    return { result: cannot(exc) };
  }
}

const ctxOf = (ctx) => ({
  root: ctx.root ?? process.cwd(),
  limits: ctx.limits ?? LIMITS,
});

/**
 * Read a regular file as UTF-8 text, if it is within the byte limit.
 *
 * @param {string} file
 * @param {{root?: string, limits?: typeof LIMITS}} [ctx]
 */
export function readText(file, ctx = {}) {
  const { root, limits } = ctxOf(ctx);
  const { abs, stat, result } = locate(file, root);
  if (result) return result;
  if (!stat.isFile()) return NOT_REGULAR;
  if (stat.size > limits.bytes) {
    return {
      kind: 'not-read',
      reason: `not read: ${stat.size} bytes is over the ${limits.bytes}-byte limit`,
    };
  }
  try {
    return { kind: 'ok', value: fs.readFileSync(abs, 'utf8') };
  } catch (exc) {
    return cannot(exc);
  }
}

/** Only a number is taken from the parser's message, never its text. */
const POSITION = /position (\d+)/;

/**
 * JSON.parse, tagged. A failure names the error and the position, and quotes
 * none of the input.
 */
export function parseJson(text) {
  try {
    return { kind: 'ok', value: JSON.parse(text) };
  } catch (exc) {
    const at = POSITION.exec(String(exc.message));
    const where = at ? `at position ${at[1]}` : '(no position given)';
    return { kind: 'invalid', reason: `not valid JSON: ${exc.name} ${where}` };
  }
}

/** `readText`, then `parseJson`. */
export function readJson(file, ctx = {}) {
  const text = readText(file, ctx);
  return text.kind === 'ok' ? parseJson(text.value) : text;
}

const gated = (name, prefix) =>
  name.startsWith(prefix) && name.endsWith('.json');

function listDirectory(abs, prefix, limits) {
  let names;
  try {
    names = fs.readdirSync(abs);
  } catch (exc) {
    return cannot(exc);
  }
  const picked = names.filter((n) => gated(n, prefix)).sort();
  if (picked.length > limits.files) {
    return {
      kind: 'not-read',
      reason: `not read: ${picked.length} files is over the ${limits.files}-file limit`,
    };
  }
  return { kind: 'ok', value: picked };
}

/**
 * One `<prefix>*.json` file, or every such file in a directory, each read with
 * `readJson` under the same containment. The list is `[{name, read}]` in
 * sorted name order; a symlinked or non-regular entry is listed with its
 * not-read or unreadable result, never followed.
 *
 * @param {string} target file or directory
 * @param {string} prefix file-name prefix every file must carry
 * @param {{root?: string, limits?: typeof LIMITS}} [ctx]
 */
export function readJsonFiles(target, prefix, ctx = {}) {
  const { root, limits } = ctxOf(ctx);
  const { abs, stat, result } = locate(target, root);
  if (result) return result;
  if (stat.isFile()) {
    const name = path.basename(abs);
    if (!gated(name, prefix)) {
      return { kind: 'unreadable', reason: `not a ${prefix}*.json file` };
    }
    return { kind: 'ok', value: [{ name, read: readJson(abs, ctx) }] };
  }
  if (!stat.isDirectory()) return NOT_REGULAR;
  const listed = listDirectory(abs, prefix, limits);
  if (listed.kind !== 'ok') return listed;
  return {
    kind: 'ok',
    value: listed.value.map((name) => ({
      name,
      read: readJson(path.join(abs, name), ctx),
    })),
  };
}

/**
 * The not-read reason for a collection of `count` entries, or null when it is
 * within the entry limit.
 */
export function overEntries(count, limits = LIMITS) {
  if (count <= limits.entries) return null;
  return `not read: ${count} entries is over the ${limits.entries}-entry limit`;
}
