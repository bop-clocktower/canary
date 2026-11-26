// jsskips -- every skip-shaped call in one JS/TS test file, sorted into a
// bucket (#1319). Nothing skip-shaped may go unreported:
//
//   static    off whatever the run looks like: `it.skip('t')`, `xit`, and a
//             "condition" that is a literal (`skipIf(true)`, `runIf(false)`,
//             `test.skip(true, why)`, `test.fixme(!0)`, `test.skip(() => true)`),
//             or an argument-less `test.skip()` muting its file or test.
//   exempt    decided by the run: `skipIf(cond)`, `runIf(cond)`,
//             Playwright `test.skip(cond, why)` -- environment gates.
//   focused   `.only`, `fit`, `fdescribe`: a committed focus mutes every OTHER
//             test in its scope, so it fails the check on its own.
//
// Title-bearing static skips use diffscan's JS_SKIP, the pattern katana records
// with, so the identity (file, test) is the one a recorded row carries. The
// file is lexed once (lib/js-literals.mjs): a call inside a comment, string or
// template literal is fixture text, not a skip.

import { commentEnd, literalEnd } from '../../../lib/js-literals.mjs';
import { JS_DECL, JS_SKIP } from './diffscan.mjs';

const FOCUS = /^(?:fit|fdescribe|.*\.only)$/;

/** One argument list, allowing one level of nested parens (`() => true`). */
const ARGS = String.raw`((?:[^()]|\([^()]*\))*)`;

/** vitest/jest `x.skipIf(arg)` / `x.runIf(arg)`, with its title when it has one. */
const CALL_IF = new RegExp(
  String.raw`\b((?:it|test|describe)(?:\.\w+)*\.(skipIf|runIf))\s*\(${ARGS}\)` +
    String.raw`(?:\s*\(\s*(['"\x60])(.*?)\4)?`,
  'g',
);

/** Playwright `test.skip(arg, ...)` / `test.fixme(...)` whose first arg is not a title. */
const PW_CALL = new RegExp(
  String.raw`\b(test(?:\.describe)?\.(?:skip|fixme))\s*\(\s*(?!['"\x60])((?:[^(),]|\([^()]*\))*)`,
  'g',
);

const DECL = new RegExp(JS_DECL.source, 'g');

const TRUTHY = /^(?:true|!0|!false|1|\(\)\s*=>\s*true)$/;
const FALSY = /^(?:false|!1|!true|0|\(\)\s*=>\s*false)$/;

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

/** Does a vitest `skipIf`/`runIf` argument skip unconditionally? */
const ifIsStatic = (kind, arg) =>
  kind === 'skipIf' ? TRUTHY.test(arg) : FALSY.test(arg);

/** Does a Playwright `skip(arg)` skip unconditionally? No argument mutes too. */
const pwIsStatic = (arg) => arg === '' || TRUTHY.test(arg);

/** The file's code-level matches of `re`, each with its 1-based line. */
function codeMatches(ctx, re) {
  return [...ctx.text.matchAll(re)]
    .filter((m) => inCode(ctx.spans, m.index))
    .map((m) => ({ m, line: ctx.lineOf(m.index) }));
}

/** The title of the nearest declaration before `index`: the muted test. */
function enclosingTitle(ctx, index) {
  let title = '(file)';
  for (const d of ctx.decls) {
    if (d.index >= index) break;
    title = d[2];
  }
  return title;
}

function titledSkips(ctx, out) {
  for (const { m, line } of codeMatches(ctx, JS_SKIP)) {
    const hit = { file: ctx.file, line, test: m[3], marker: m[1] };
    (FOCUS.test(m[1]) ? out.focused : out.skips).push(hit);
  }
}

function ifSkips(ctx, out) {
  for (const { m, line } of codeMatches(ctx, CALL_IF)) {
    const arg = m[3].trim();
    if (!ifIsStatic(m[2], arg)) out.exempt += 1;
    else {
      const test = m[5] ?? enclosingTitle(ctx, m.index);
      out.skips.push({ file: ctx.file, line, test, marker: `${m[1]}(${arg})` });
    }
  }
}

function playwrightSkips(ctx, out) {
  for (const { m, line } of codeMatches(ctx, PW_CALL)) {
    const arg = m[2].trim();
    if (!pwIsStatic(arg)) out.exempt += 1;
    else {
      const test = enclosingTitle(ctx, m.index);
      out.skips.push({ file: ctx.file, line, test, marker: `${m[1]}(${arg})` });
    }
  }
}

/**
 * Every skip-shaped call in one JS/TS file, bucketed.
 * @returns {{skips: object[], focused: object[], exempt: number}}
 */
export function jsSkips(file, text) {
  const spans = opaqueSpans(text);
  const ctx = {
    file,
    text,
    spans,
    lineOf: (i) => text.slice(0, i).split('\n').length,
    decls: [...text.matchAll(DECL)].filter((d) => inCode(spans, d.index)),
  };
  const out = { skips: [], focused: [], exempt: 0 };
  titledSkips(ctx, out);
  ifSkips(ctx, out);
  playwrightSkips(ctx, out);
  out.skips.sort((a, b) => a.line - b.line);
  return out;
}
