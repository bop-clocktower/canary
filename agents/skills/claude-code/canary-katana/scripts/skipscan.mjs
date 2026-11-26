// skipscan -- every skip marker in the tree, bucketed, read with katana's own
// skip detection (#1319).
//
// `--check` asks whether every test switched off in the source has a ledger
// row. JS/TS files go through jsskips.mjs (static / exempt / focused). Python
// uses diffscan's PY_SKIP_DEC, the pattern katana RECORDS with, so a marker and
// the row katana would write share one identity: (file, test), where `test` is
// the decorated def's or class's name. Line numbers are reported, never
// matched, so a row survives the code above it moving.
//
// Static means the test is off whatever the run looks like. A skip the run
// decides -- pytest `skipif(cond)` / `xfail(cond)` -- is counted as `exempt`:
// an environment gate (#1638's `env-gated`). Triple-quoted bodies are fixture
// text, not markers.

import fs from 'node:fs';

import { PY_SKIP_DEC } from './diffscan.mjs';
import { jsSkips } from './jsskips.mjs';
import { repoTestFiles } from './testindex.mjs';

const JS_EXT = /\.(?:[cm]?[jt]sx?)$/;
const PY_EXT = /\.py$/;

/**
 * @typedef {{file: string, line: number, test: string, marker: string}} Skip
 * @typedef {{files: number, skips: Skip[], focused: Skip[], exempt: number,
 *            unmatched: string[]}} Scan
 */

/**
 * Static unless a condition decides it: `skip` always is, `skipif` only with a
 * literal `True`, `xfail` when it has no positional condition.
 */
function pyMarkerIsStatic(marker) {
  const m = /^pytest\.mark\.(skip|skipif|xfail)\b\s*(\()?\s*(.*)$/.exec(marker);
  if (!m) return false;
  const [, kind, paren, args] = m;
  if (kind === 'skip') return true;
  if (kind === 'skipif') return /^True\s*[,)]/.test(args);
  return !paren || /^(?:\)|\w+\s*=[^=])/.test(args);
}

const PY_TARGET = /^(?:async\s+)?(?:def|class)\s+(\w+)/;
const TRIPLE = /"""|'''/g;

/** Code lines of a Python file as [lineNo, text], triple-quoted bodies dropped. */
function pyCodeLines(text) {
  const out = [];
  let inDoc = false;
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    const toggles = (line.match(TRIPLE) ?? []).length % 2 === 1;
    if (toggles) inDoc = !inDoc;
    else if (!inDoc) out.push([i + 1, line]);
  });
  return out;
}

/** One line's effect: a decorator arms `pending`, a def/class consumes it. */
function pyStep(state, file, [lineNo, line]) {
  const dec = PY_SKIP_DEC.exec(line);
  if (dec && pyMarkerIsStatic(dec[1])) {
    state.pending ??= { line: lineNo, marker: dec[1] };
  } else if (dec) {
    state.exempt += 1;
  } else if (PY_TARGET.test(line)) {
    const [, test] = PY_TARGET.exec(line);
    if (state.pending) state.skips.push({ file, test, ...state.pending });
    state.pending = null;
  }
}

/** The static skips and the count of conditional ones in one Python file. */
function pySkips(file, text) {
  const state = { skips: [], exempt: 0, pending: null };
  for (const entry of pyCodeLines(text)) pyStep(state, file, entry);
  return { skips: state.skips, focused: [], exempt: state.exempt };
}

const readText = (abs) => {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null; // unreadable is skipped, as testindex does (#395)
  }
};

/** `p` as a repo-relative posix prefix; '' selects everything. */
const normPath = (p) =>
  p
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .replace(/^\.$/, '');

const under = (rel, want) =>
  want === '' || rel === want || rel.startsWith(`${want}/`);

/** The paths a file is selected by; every file when no path was given. */
const selectors = (rel, paths) =>
  paths.length ? paths.filter((p) => under(rel, normPath(p))) : [null];

function addFound(scan, found) {
  scan.files += 1;
  scan.skips.push(...found.skips);
  scan.focused.push(...found.focused);
  scan.exempt += found.exempt;
}

/**
 * Every skip marker in `repo`'s test files, optionally narrowed to `paths`
 * (repo-relative files or directories). `files` is the denominator: how many
 * test files were actually read. `unmatched` names each path that selected
 * no readable test file: a typo must abstain, never narrow the run to green.
 * @returns {Scan}
 */
export function scanSkips(repo, paths = []) {
  const scan = { files: 0, skips: [], focused: [], exempt: 0, unmatched: [] };
  const hits = new Set();
  for (const [rel, abs] of repoTestFiles(repo)) {
    const lang = PY_EXT.test(rel) ? pySkips : JS_EXT.test(rel) ? jsSkips : null;
    const by = lang ? selectors(rel, paths) : [];
    const text = by.length ? readText(abs) : null;
    if (text === null) continue;
    by.forEach((p) => hits.add(p));
    addFound(scan, lang(rel, text));
  }
  scan.unmatched = paths.filter((p) => !hits.has(p));
  return scan;
}
