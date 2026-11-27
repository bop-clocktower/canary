// read -- bounded reads of every input canary-batgirl scores (spec D9).
//
// Every result is tagged, never thrown, so the caller decides what each case
// means for its dimension:
//
//   missing     the path does not exist
//   unreadable  it exists but cannot be read as the expected kind
//   not-read    it is over a limit, so it was deliberately not read
//   invalid     it was read but is not valid JSON
//   ok          `value` holds the text, the parsed JSON, or a file list
//
// An input over a limit is not read at all: a value computed from its first N
// rows would misrepresent the whole, and the bound is what keeps every later
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

function statOf(file) {
  try {
    return { stat: fs.statSync(file) };
  } catch (exc) {
    if (exc.code === 'ENOENT') return { result: { kind: 'missing' } };
    return { result: { kind: 'unreadable', reason: exc.message } };
  }
}

/**
 * Read a file as UTF-8 text, if it is a file within the byte limit.
 *
 * @param {string} file
 * @param {typeof LIMITS} [limits]
 */
export function readText(file, limits = LIMITS) {
  const { stat, result } = statOf(file);
  if (result) return result;
  if (!stat.isFile()) return { kind: 'unreadable', reason: 'not a file' };
  if (stat.size > limits.bytes) {
    return {
      kind: 'not-read',
      reason: `not read: ${stat.size} bytes is over the ${limits.bytes}-byte limit`,
    };
  }
  try {
    return { kind: 'ok', value: fs.readFileSync(file, 'utf8') };
  } catch (exc) {
    return { kind: 'unreadable', reason: exc.message };
  }
}

/**
 * `readText`, then JSON.parse. A parse failure is `invalid`, with the parser's
 * message (which may quote file content: callers escape it before printing).
 */
export function readJson(file, limits = LIMITS) {
  const text = readText(file, limits);
  if (text.kind !== 'ok') return text;
  try {
    return { kind: 'ok', value: JSON.parse(text.value) };
  } catch (exc) {
    return { kind: 'invalid', reason: `not valid JSON: ${exc.message}` };
  }
}

function listDirectory(dir, prefix, limits) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (exc) {
    return { kind: 'unreadable', reason: exc.message };
  }
  const picked = names
    .filter((n) => n.startsWith(prefix) && n.endsWith('.json'))
    .sort();
  if (picked.length > limits.files) {
    return {
      kind: 'not-read',
      reason: `not read: ${picked.length} files is over the ${limits.files}-file limit`,
    };
  }
  return { kind: 'ok', value: picked };
}

/**
 * One JSON file, or every `<prefix>*.json` in a directory, each read with
 * `readJson`. The list is `[{name, read}]` in sorted name order.
 *
 * @param {string} target file or directory
 * @param {string} prefix file-name prefix a directory entry must carry
 * @param {typeof LIMITS} [limits]
 */
export function readJsonFiles(target, prefix, limits = LIMITS) {
  const { stat, result } = statOf(target);
  if (result) return result;
  if (!stat.isDirectory()) {
    const name = path.basename(target);
    return { kind: 'ok', value: [{ name, read: readJson(target, limits) }] };
  }
  const listed = listDirectory(target, prefix, limits);
  if (listed.kind !== 'ok') return listed;
  return {
    kind: 'ok',
    value: listed.value.map((name) => ({
      name,
      read: readJson(path.join(target, name), limits),
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
