// skipscan -- every STATIC skip marker in the tree, read with katana's own
// skip detection (#1319).
//
// `--check` asks whether every test switched off in the source has a ledger
// row. The markers are found with the same `JS_SKIP` / `PY_SKIP_DEC` patterns
// diffscan uses when it RECORDS a skip, so a marker and the row katana would
// write for it share one identity: (file, test), where `test` is the title in
// the skip call (JS) or the decorated def's name (Python). Line numbers are
// reported, never matched, so a row survives the code above it moving.
//
// Static means the test is off whatever the run looks like. A skip that
// depends on the run -- `it.skipIf(cond)`, Playwright's `test.skip(cond, why)`,
// pytest `skipif(cond)` / `xfail(cond)` -- is counted as `exempt`, not as a
// skip: those are environment gates (#1638's `env-gated`), and failing CI on
// every one would get the check muted.
//
// The whole-file text is lexed once (lib/js-literals.mjs) so a marker inside a
// comment, string or template literal is not one: test suites keep fixture
// source that only looks like a skip.

import fs from 'node:fs';

import { commentEnd, literalEnd } from '../../../lib/js-literals.mjs';
import { JS_SKIP, PY_SKIP_DEC } from './diffscan.mjs';
import { repoTestFiles } from './testindex.mjs';

const JS_EXT = /\.(?:[cm]?[jt]sx?)$/;
const PY_EXT = /\.py$/;

/** JS_SKIP also matches focus markers; those run a test, they do not mute it. */
const FOCUS = /^(?:fit|fdescribe|.*\.only)$/;

/** Runtime-conditional JS skips: vitest's skipIf/runIf, Playwright's skip(cond). */
const JS_CONDITIONAL = [
  /\b(?:it|test|describe)(?:\.\w+)*\.(?:skipIf|runIf)\s*\(/g,
  /\btest(?:\.describe)?\.(?:skip|fixme)\s*\(\s*(?![\s)'"`])/g,
];

/**
 * @typedef {{file: string, line: number, test: string, marker: string}} Skip
 * @typedef {{files: number, skips: Skip[], exempt: number}} Scan
 */

/** [start, end) of every comment and literal in `code`, in order. */
function opaqueSpans(code) {
  const spans = [];
  let last = -1;
  for (let i = 0; i < code.length; i += 1) {
    if (/\s/.test(code[i])) continue;
    const comment = commentEnd(code, i);
    const end = comment ?? literalEnd(code, i, last);
    if (end === null) {
      last = i;
      continue;
    }
    spans.push([i, end]);
    if (comment === null) last = end - 1;
    i = end - 1;
  }
  return spans;
}

/** Is `index` executable code, outside every span? Spans are sorted. */
function inCode(spans, index) {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [from, to] = spans[mid];
    if (index < from) hi = mid - 1;
    else if (index >= to) lo = mid + 1;
    else return false;
  }
  return true;
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/** The static skips and the count of conditional ones in one JS/TS file. */
function jsSkips(file, text) {
  const spans = opaqueSpans(text);
  const skips = [];
  for (const m of text.matchAll(JS_SKIP)) {
    if (FOCUS.test(m[1]) || !inCode(spans, m.index)) continue;
    skips.push({ file, line: lineOf(text, m.index), test: m[3], marker: m[1] });
  }
  let exempt = 0;
  for (const re of JS_CONDITIONAL) {
    for (const m of text.matchAll(re)) if (inCode(spans, m.index)) exempt += 1;
  }
  return { skips, exempt };
}

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

/** The static skips and the count of conditional ones in one Python file. */
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
  return { skips: state.skips, exempt: state.exempt };
}

const readText = (abs) => {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null; // unreadable is skipped, as testindex does (#395)
  }
};

/** Is repo-relative `rel` one of `paths` or under one of them? */
function selected(rel, paths) {
  if (!paths.length) return true;
  return paths.some((p) => {
    const want = p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    return (
      want === '' || want === '.' || rel === want || rel.startsWith(`${want}/`)
    );
  });
}

/**
 * Every static skip in `repo`'s test files, optionally narrowed to `paths`
 * (repo-relative files or directories). `files` is the denominator: how many
 * test files were actually read. Zero files is not a clean suite.
 * @returns {Scan}
 */
export function scanSkips(repo, paths = []) {
  const scan = { files: 0, skips: [], exempt: 0 };
  for (const [rel, abs] of repoTestFiles(repo)) {
    const lang = PY_EXT.test(rel) ? pySkips : JS_EXT.test(rel) ? jsSkips : null;
    if (!lang || !selected(rel, paths)) continue;
    const text = readText(abs);
    if (text === null) continue;
    const found = lang(rel, text);
    scan.files += 1;
    scan.skips.push(...found.skips);
    scan.exempt += found.exempt;
  }
  return scan;
}
