// markers -- where a quarantined test sits in the code, and whether it is
// still switched off.
//
// Every shape a quarantine takes, read the same way:
//
//   static     test.skip('t') / it.skip / describe.skip / test.describe.skip /
//              test.fixme / xit / xdescribe / xtest
//   runtime    a call inside the test body that skips it at run time. The
//              ledger writes these as `<callee>(condition)`: `test.skip(condition)`
//              is Playwright's own, `requireLiveWindow(condition)` a suite helper.
//   pytest     @pytest.mark.skip / skipif / xfail above `def test_*`
//   tag        a configured tag in the title (`@known-failure`)
//
// Line-oriented with a small lexer pass, like katana: comments are blanked
// before matching (a commented-out test is not a quarantined one), and the
// unledgered scan also blanks template literals, where test files keep
// fixture source that only looks like a skip.

import fs from 'node:fs';
import path from 'node:path';

import { commentEnd, literalEnd } from '../../../lib/js-literals.mjs';

export const DEFAULT_TAGS = ['@known-failure', '@quarantine'];

export const PY_EXT = /\.py$/;

/** Declarations with a literal title; the title may start on the next line. */
const JS_DECL =
  /\b((?:test|it|describe|context|xit|xtest|xdescribe)(?:\.\w+)*)\s*\(\s*(['"`])((?:\\.|(?!\2)[^\\])*?)\2/gs;
const PY_DEF = /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/;
const PY_SKIP = /^\s*@(pytest\.mark\.(?:skip|skipif|xfail)\b.*)$/;

export const STATIC_SKIP = /(?:^|\.)(?:skip|fixme)$|^x(?:it|test|describe)$/;

/** `code` with each span from..to replaced by spaces, newlines kept. */
function blankSpan(chars, from, to) {
  for (let j = from; j < to; j += 1) if (chars[j] !== '\n') chars[j] = ' ';
}

/**
 * Blank comments (always) and template-literal bodies (when `templates`),
 * keeping offsets and line numbers identical to the source.
 */
export function maskJs(code, { templates = false } = {}) {
  const out = code.split('');
  let last = -1;
  for (let i = 0; i < code.length; i += 1) {
    if (/\s/.test(code[i])) continue;
    const comment = commentEnd(code, i);
    const end = comment ?? literalEnd(code, i, last);
    if (end === null) {
      last = i;
      continue;
    }
    if (comment !== null) blankSpan(out, i, end);
    else if (templates && code[i] === '`') blankSpan(out, i + 1, end - 1);
    if (comment === null) last = end - 1;
    i = end - 1;
  }
  return out.join('');
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length;

/** Every JS declaration in `masked`: callee, title, 1-based line. */
export function jsDeclarations(masked) {
  return [...masked.matchAll(JS_DECL)].map((m) => ({
    callee: m[1],
    title: m[3],
    line: lineAt(masked, m.index),
  }));
}

/**
 * One python line with its `#` comment blanked (a `#` inside a string is
 * kept), and the net bracket depth of what is left.
 */
function pyLine(text) {
  let quote = '';
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#') return { code: text.slice(0, i), depth };
    else if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
  }
  return { code: text, depth };
}

/**
 * Every python test function, with the skip decorators stacked on it. Read
 * top-down so a decorator whose arguments span lines
 * (`@pytest.mark.skipif(\n  cond,\n  reason=...)`) is joined into one.
 */
export function pyDeclarations(source) {
  const lines = source.split('\n');
  const out = [];
  let stack = [];
  for (let i = 0; i < lines.length; i += 1) {
    const def = PY_DEF.exec(lines[i]);
    if (def) {
      out.push({
        callee: 'def',
        title: def[2],
        line: i + 1,
        markerLine: stack.length ? stack[0].line : i + 1,
        decorators: stack.flatMap((d) => {
          const skip = PY_SKIP.exec(d.text);
          return skip ? [skip[1]] : [];
        }),
      });
      stack = [];
    } else if (/^\s*@/.test(lines[i])) {
      const at = i;
      let { code, depth } = pyLine(lines[i]);
      const parts = [code.trim()];
      while (depth > 0 && i + 1 < lines.length) {
        i += 1;
        const next = pyLine(lines[i]);
        parts.push(next.code.trim());
        depth += next.depth;
      }
      stack.push({ line: at + 1, text: joinArgs(parts) });
    } else stack = [];
  }
  return out;
}

/** `['f(', 'a,', 'b', ')']` -> `f(a, b)`: a wrapped call read as one line. */
const joinArgs = (parts) =>
  parts
    .filter(Boolean)
    .join(' ')
    .replace(/([([{])\s+/g, '$1')
    .replace(/,?\s+([)\]}])/g, '$1');

/**
 * The comment block directly above line `n` (1-based), top to bottom, plus
 * the statement on line `n` itself. Stops at the first line that is neither a
 * comment nor a decorator, so a comment two declarations up is never read as
 * this test's reason.
 */
export function commentAbove(lines, n) {
  return [...commentBlock(lines, n), ...statementAt(lines, n)].join('\n');
}

const COMMENTISH = /^(?:\/\/|\/\*|\*|#|@)/;

/** The contiguous comment/decorator lines directly above line `n`. */
function commentBlock(lines, n) {
  const block = [];
  for (let i = n - 2; i >= 0; i -= 1) {
    const t = lines[i].trim();
    if (!COMMENTISH.test(t) && !t.endsWith('*/')) break;
    block.unshift(t);
  }
  return block;
}

/** Line `n`, plus its continuation when the call's arguments span lines. */
function statementAt(lines, n) {
  const stmt = [(lines[n - 1] ?? '').trim()];
  // Already complete: it opens a body, or it closes its own call.
  if (/(?:\{|\)\s*;?)\s*$/.test(stmt[0])) return stmt;
  for (let i = n; i < Math.min(lines.length, n + 8); i += 1) {
    stmt.push(lines[i].trim());
    if (/\)\s*;?\s*$/.test(lines[i])) break;
  }
  return stmt;
}

/** Read and lex one file once; null when it does not exist. */
export function readSource(repo, file) {
  const abs = path.join(repo, file);
  let source;
  try {
    source = fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
  const lines = source.split('\n');
  if (PY_EXT.test(file)) {
    // `code` is the source with comments blanked: what actually runs.
    const code = lines.map((l) => pyLine(l).code);
    return { file, lines, code, lang: 'py', decls: pyDeclarations(source) };
  }
  const masked = maskJs(source);
  return {
    file,
    lines,
    code: masked.split('\n'),
    lang: 'js',
    decls: jsDeclarations(masked),
  };
}

/** The declarations whose title is the row's test: exact first, then contains. */
function findByTitle(src, title) {
  // An empty title is contained in every title: it names no test at all.
  if (!title) return { decls: [], match: null };
  const exact = src.decls.filter((d) => d.title === title);
  if (exact.length) return { decls: exact, match: 'exact' };
  const contains = src.decls.filter((d) => d.title.includes(title));
  if (contains.length) return { decls: contains, match: 'contains' };
  return { decls: [], match: null };
}

/** `test.skip(condition)` -> `test.skip`; null for a static marker. */
export function runtimeCallee(marker) {
  const m = /^([\w.$]+)\(condition\)$/.exec(String(marker ?? '').trim());
  return m ? m[1] : null;
}

/** The body lines of the declaration at index `k`: up to the next declaration. */
function bodyRange(src, k) {
  const sorted = [...src.decls].sort((a, b) => a.line - b.line);
  const at = sorted.indexOf(src.decls[k]);
  const next = sorted[at + 1];
  return [src.decls[k].line, next ? next.line - 1 : src.lines.length];
}

/** Is a static/pytest/tag marker in force on `decl`? Returns the marker line or 0. */
export function staticMarkerLine(src, decl, tags) {
  if (src.lang === 'py') return decl.decorators.length ? decl.markerLine : 0;
  if (STATIC_SKIP.test(decl.callee)) return decl.line;
  if (tags.some((t) => decl.title.includes(t))) return decl.line;
  return 0;
}

/**
 * The first line in `decl`'s body that calls `callee(`, or 0. Read from the
 * comment-blanked source: `// test.skip(cond)` is a skip someone turned off.
 */
function runtimeMarkerLine(src, decl, callee) {
  const [from, to] = bodyRange(src, src.decls.indexOf(decl));
  const code = src.code ?? src.lines;
  for (let i = from; i < to; i += 1) {
    if (code[i].includes(`${callee}(`)) return i + 1;
  }
  return 0;
}

const NOT_FOUND = {
  found: false,
  marked: false,
  match: null,
  line: 0,
  markerLine: 0,
  context: '',
};

/**
 * Where row `row` (a ledger entry) sits in `src`, and whether its quarantine
 * is still in force.
 *
 * @returns {{found: boolean, marked: boolean, match: string|null, line: number,
 *            markerLine: number, context: string, why: string}}
 */
export function locate(src, row, tags = DEFAULT_TAGS) {
  if (!src) return { ...NOT_FOUND, why: `${row.file} does not exist` };
  const { decls, match } = findByTitle(src, row.test);
  if (!decls.length)
    return { ...NOT_FOUND, why: `no test titled "${row.test}" in ${row.file}` };
  const callee = runtimeCallee(row.marker);
  for (const decl of decls) {
    const markerLine = callee
      ? runtimeMarkerLine(src, decl, callee)
      : staticMarkerLine(src, decl, tags);
    if (markerLine) {
      const context = commentAbove(src.lines, markerLine);
      return {
        found: true,
        marked: true,
        match,
        line: decl.line,
        markerLine,
        context,
        why: '',
      };
    }
  }
  const what = callee
    ? `no ${callee}(...) call in its body`
    : 'it is no longer skipped';
  return {
    ...NOT_FOUND,
    found: true,
    match,
    line: decls[0].line,
    why: `the test is present but ${what}`,
  };
}
