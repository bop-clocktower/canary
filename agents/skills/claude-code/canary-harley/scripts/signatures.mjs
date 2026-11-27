/**
 * canary-harley -- parameter and return types for the functions the engine's
 * extractor names.
 *
 * The extractor returns names only, so this module finds each declaration and
 * reads it with the bracket-aware scan. A declaration it will not read (async,
 * generic, overloaded, nested, rest or destructured parameters) is skipped
 * with the reason named; it is never read approximately.
 */
import path from 'node:path';

import { matchClose, splitTopLevel } from './scan.mjs';
import { parseType } from './types.mjs';

const LANGS = new Map([
  ['.ts', 'typescript'],
  ['.tsx', 'typescript'],
  ['.js', 'javascript'],
  ['.jsx', 'javascript'],
  ['.mjs', 'javascript'],
  ['.py', 'python'],
]);

// A character no source holds, used to find a top-level `=>`.
const ARROW_MARK = '\u0000';

/**
 * @param {string} file a source path
 * @returns {'typescript' | 'javascript' | 'python' | null}
 */
export function langOf(file) {
  return LANGS.get(path.extname(file).toLowerCase()) ?? null;
}

/**
 * A name is matched as text. The extractor yields identifiers, where `$` is
 * the one character a regex reads as syntax, but every such character is
 * escaped (the backslash included) so no name can act as a pattern.
 */
const escapeName = (name) => name.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

// Indent, then an optional `export`: groups 1 and 2 of both patterns.
const TS_HEAD = '^([ \\t]*)(export\\s+)?';

/**
 * Every `function NAME` and `const NAME =` declaration, in that order (the
 * extractor's two patterns). `open` is the index of the `(` or `<` that
 * follows the name.
 */
function findTsDeclarations(source, name) {
  const id = escapeName(name);
  const patterns = [
    `${TS_HEAD}(?:default\\s+)?(async\\s+)?function\\s+${id}\\s*[(<]`,
    `${TS_HEAD}const\\s+${id}\\s*=\\s*(async\\s*)?[(<]`,
  ];
  return patterns.flatMap((pattern, index) =>
    [...source.matchAll(new RegExp(pattern, 'gm'))].map((match) => ({
      indent: match[1].length,
      exported: match[2] !== undefined,
      async: match[3] !== undefined,
      arrow: index === 1,
      open: match.index + match[0].length - 1,
    })),
  );
}

/** The parameter texts between `open` and its closer (-1 when unbalanced). */
function readParams(source, open) {
  const close = matchClose(source, open);
  if (close === -1) return { close, texts: [] };
  return { close, texts: splitTopLevel(source.slice(open + 1, close), ',') };
}

function asOptional(type) {
  return type.kind === 'optional' ? type : { kind: 'optional', inner: type };
}

/** One parameter: the default is dropped, then name and type part at `:`. */
function readParam(text, lang) {
  const head = splitTopLevel(text, '=')[0] ?? '';
  const colon = head.indexOf(':');
  const name = (colon === -1 ? head : head.slice(0, colon)).trim();
  const type = parseType(colon === -1 ? '' : head.slice(colon + 1), lang);
  if (!name.endsWith('?')) return { name, type };
  return { name: name.slice(0, -1).trim(), type: asOptional(type) };
}

/** The text after the parameter list, with leading space removed. */
const tailOf = (source, close) => source.slice(close + 1).trimStart();

/** The return type text: after `:` up to a top-level `{`, `=>` or `;`. */
function readTsReturn(source, close) {
  const tail = tailOf(source, close);
  if (!tail.startsWith(':')) return '';
  const text = tail.slice(1).trimStart();
  if (text.startsWith('{')) {
    // An object return type opens with the brace a body would.
    return text.slice(0, matchClose(text, 0) + 1);
  }
  const marked = text.replaceAll('=>', ARROW_MARK);
  return splitTopLevel(marked, `{;${ARROW_MARK}`)[0] ?? '';
}

/** A `const NAME = (` is a function only when `=>` or a return type follows. */
function isArrowFunction(ctx) {
  const tail = tailOf(ctx.source, ctx.close);
  return tail.startsWith('=>') || tail.startsWith(':');
}

// Checked in order; the first match is the reason. Later checks rely on the
// earlier ones (a declaration exists, its list was read).
const TS_SKIPS = [
  [(ctx) => ctx.decls.length === 0, 'declaration not found'],
  [(ctx) => ctx.decls.length > 1, 'overloaded function'],
  [(ctx) => ctx.decl.indent > 0, 'nested function'],
  [(ctx) => ctx.decl.async, 'async function'],
  [(ctx) => ctx.source[ctx.decl.open] === '<', 'generic function'],
  [(ctx) => ctx.close === -1, 'declaration not readable'],
  [(ctx) => ctx.decl.arrow && !isArrowFunction(ctx), 'not a function'],
  [(ctx) => ctx.texts.some((text) => text.startsWith('...')), 'rest parameter'],
  [
    (ctx) => ctx.texts.some((text) => /^[{[]/.test(text)),
    'destructured parameter',
  ],
];

const TS_READER = {
  find: findTsDeclarations,
  skips: TS_SKIPS,
  readReturn: readTsReturn,
  isExported: (decl) => decl.exported,
};

/**
 * Every `def NAME(` declaration, least indented first, so a module-level
 * function wins over a method that shares its name.
 */
function findPyDeclarations(source, name) {
  const pattern = new RegExp(
    `^([ \\t]*)(async\\s+)?def\\s+${escapeName(name)}\\s*\\(`,
    'gm',
  );
  return [...source.matchAll(pattern)]
    .map((match) => ({
      indent: match[1].length,
      async: match[2] !== undefined,
      open: match.index + match[0].length - 1,
    }))
    .sort((a, b) => a.indent - b.indent);
}

/** The annotation between `->` and the `:` that opens the body. */
function readPyReturn(source, close) {
  const tail = tailOf(source, close);
  if (!tail.startsWith('->')) return '';
  return splitTopLevel(tail.slice(2), ':')[0] ?? '';
}

const PY_SKIPS = [
  [(ctx) => ctx.decls.length === 0, 'declaration not found'],
  [(ctx) => ctx.decl.indent > 0, 'method or nested function'],
  [(ctx) => ctx.decl.async, 'async function'],
  [(ctx) => ctx.close === -1, 'declaration not readable'],
  [
    (ctx) => ctx.texts.some((text) => /^\*{1,2}[A-Za-z_]/.test(text)),
    'rest parameter',
  ],
  [
    (ctx) => ctx.texts.some((text) => text === '/' || text === '*'),
    'positional-only or keyword-only marker',
  ],
];

const PY_READER = {
  find: findPyDeclarations,
  skips: PY_SKIPS,
  readReturn: readPyReturn,
  // Only module-level functions are read, and those are importable.
  isExported: () => true,
};

const READERS = {
  typescript: TS_READER,
  javascript: TS_READER,
  python: PY_READER,
};

function contextFor(source, decls) {
  const decl = decls[0];
  const list = decl ? readParams(source, decl.open) : { close: -1, texts: [] };
  return { source, decls, decl, close: list.close, texts: list.texts };
}

function readOne(source, lang, name) {
  const reader = READERS[lang];
  const ctx = contextFor(source, reader.find(source, name));
  const skip = reader.skips.find(([applies]) => applies(ctx));
  if (skip) return { skip: { name, reason: skip[1] } };
  const signature = {
    name,
    lang,
    params: ctx.texts.map((text) => readParam(text, lang)),
    returns: parseType(reader.readReturn(source, ctx.close), lang),
    exported: reader.isExported(ctx.decl),
  };
  return { signature };
}

/**
 * @param {string} source the file's text
 * @param {'typescript' | 'javascript' | 'python'} lang
 * @param {string[]} names the functions to read, in the order to report them
 * @returns {{ signatures: object[], skipped: object[] }} each skip is
 *   `{ name, reason }`
 */
export function readSignatures(source, lang, names) {
  const results = names.map((name) => readOne(source, lang, name));
  return {
    signatures: results.flatMap((result) => result.signature ?? []),
    skipped: results.flatMap((result) => result.skip ?? []),
  };
}
