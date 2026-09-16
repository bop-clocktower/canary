/**
 * Throwaway spike harness for #765 D2. NOT canary engine code.
 *
 * Shared helpers: locate a `typescript` install, build a Program under one of
 * several configurations, and walk a checker Type into a ShapeNode-shaped tree
 * (the `ShapeNode` union sketched in the #765 proposal's "Shape model").
 *
 * Nothing under ts/ imports this file.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const REPO_TS = path.resolve(import.meta.dirname, '..', '..', 'ts');

/** Resolve a `typescript` module from an explicit root, else the repo's. */
export async function loadTs(root) {
  const base = root ?? REPO_TS;
  const req = createRequire(path.join(base, 'noop.js'));
  const entry = req.resolve('typescript');
  const mod = await import(pathToFileURL(entry).href);
  const ts = mod.default ?? mod;
  return { ts, version: ts.version, entry };
}

/**
 * Program configurations under test.
 *
 * `full` mirrors what a naive implementation would do: read tsconfig.json and
 * hand the compiler the whole `include`. The others narrow it progressively.
 */
export const CONFIGS = {
  /** Everything tsconfig.json includes; lib checking on. */
  full: { skipLibCheck: false, noResolve: false, narrowed: false },
  /** Narrowed fileNames, imports still followed, .d.ts checking skipped. */
  narrowed: { skipLibCheck: true, noResolve: false, narrowed: true },
  /** Narrowed fileNames, module resolution OFF. */
  noresolve: { skipLibCheck: true, noResolve: true, narrowed: true },
};

export function compilerOptions(ts, cfg) {
  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: cfg.skipLibCheck,
    noResolve: cfg.noResolve,
    types: [],
  };
}

export function buildProgram(ts, fileNames, cfg) {
  return ts.createProgram({
    rootNames: fileNames,
    options: compilerOptions(ts, cfg),
  });
}

/** A single-file parse with no checker and no module resolution at all. */
export function parseOnly(ts, file, text) {
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
}

// ---------------------------------------------------------------------------
// ShapeNode extraction
// ---------------------------------------------------------------------------

const MAX_DEPTH = 6;

function unresolved(reason, typeText) {
  return { kind: 'unresolved', reason, typeText };
}

/**
 * Walk a checker Type into a ShapeNode tree.
 *
 * Deliberately conservative: anything this does not positively recognise
 * becomes `unresolved` with a reason, because #765's abstention rule makes
 * "cannot resolve" a first-class outcome rather than a guess.
 */
export function shapeOf(ts, checker, type, depth = 0, seen = new Set()) {
  const F = ts.TypeFlags;
  const text = checker.typeToString(type);

  if (depth > MAX_DEPTH) return unresolved('depth limit reached', text);

  if (type.flags & (F.Any | F.Unknown)) {
    return unresolved(
      type.flags & F.Any ? 'type is any' : 'type is unknown',
      text,
    );
  }
  if (type.flags & F.Never) return unresolved('type is never', text);
  if (type.flags & F.TypeParameter) {
    return unresolved('unbound type parameter', text);
  }
  if (type.flags & (F.Void | F.Undefined)) return { kind: 'undefined' };
  if (type.flags & F.Null) return { kind: 'null' };
  if (type.flags & F.BooleanLike) return { kind: 'boolean' };
  if (type.isStringLiteral()) {
    return { kind: 'string', enum: [type.value] };
  }
  if (type.isNumberLiteral()) {
    return { kind: 'number', integer: Number.isInteger(type.value) };
  }
  if (type.flags & F.String) return { kind: 'string' };
  if (type.flags & F.Number) return { kind: 'number', integer: false };
  if (type.flags & F.BigInt) return { kind: 'number', integer: true };
  if (type.flags & F.ESSymbolLike) {
    return unresolved('symbol type is not data-expressible', text);
  }

  if (type.isUnion()) {
    const members = type.types.map((t) =>
      shapeOf(ts, checker, t, depth + 1, seen),
    );
    // Collapse the literal unions TS models as an enum.
    const allStringLits = type.types.every((t) => t.isStringLiteral());
    if (allStringLits) {
      return { kind: 'string', enum: type.types.map((t) => t.value) };
    }
    return { kind: 'union', members };
  }
  if (type.isIntersection()) {
    return unresolved('intersection type not modelled in v1', text);
  }

  if (checker.isArrayType?.(type)) {
    const [item] = checker.getTypeArguments(type);
    return {
      kind: 'array',
      item: item
        ? shapeOf(ts, checker, item, depth + 1, seen)
        : unresolved('array element type unavailable', text),
    };
  }
  if (checker.isTupleType?.(type)) {
    return unresolved('tuple type not modelled in v1', text);
  }

  const sym = type.getSymbol?.();
  const name = sym?.getName?.();
  if (name === 'Date') return { kind: 'date' };
  if (name === 'Map' || name === 'Set' || name === 'Promise') {
    return unresolved(`${name} is not data-expressible in v1`, text);
  }
  if (type.getCallSignatures?.().length > 0) {
    return unresolved('callable type (function-valued field)', text);
  }

  if (type.flags & F.Object) {
    const key = text;
    if (seen.has(key)) return unresolved('recursive type', text);
    const nextSeen = new Set(seen).add(key);

    const idx =
      checker.getIndexInfoOfType?.(type, ts.IndexKind.String) ??
      checker.getIndexInfoOfType?.(type, ts.IndexKind.Number);
    const props = checker.getPropertiesOfType(type);
    if (idx && props.length === 0) {
      return unresolved(
        'index signature: field names are not statically known',
        text,
      );
    }

    const fields = {};
    for (const prop of props) {
      const decl = prop.valueDeclaration ?? prop.declarations?.[0];
      const pType = decl
        ? checker.getTypeOfSymbolAtLocation(prop, decl)
        : checker.getDeclaredTypeOfSymbol(prop);
      const optional = Boolean(prop.flags & ts.SymbolFlags.Optional);
      fields[prop.getName()] = {
        node: shapeOf(ts, checker, pType, depth + 1, nextSeen),
        optional,
      };
    }
    if (Object.keys(fields).length === 0) {
      return unresolved('object type exposes no properties', text);
    }
    return { kind: 'object', fields };
  }

  return unresolved('unrecognised type flags', text);
}

/** Count leaf nodes and unresolved leaves in a ShapeNode tree. */
export function denominator(node, acc = { total: 0, unresolved: [] }, p = '$') {
  if (!node) return acc;
  if (node.kind === 'object') {
    for (const [k, v] of Object.entries(node.fields)) {
      denominator(v.node, acc, `${p}.${k}`);
    }
    return acc;
  }
  if (node.kind === 'array') return denominator(node.item, acc, `${p}[]`);
  if (node.kind === 'union') {
    node.members.forEach((m, i) => denominator(m, acc, `${p}|${i}`));
    return acc;
  }
  acc.total += 1;
  if (node.kind === 'unresolved') {
    acc.unresolved.push({
      path: p,
      reason: node.reason,
      typeText: node.typeText,
    });
  }
  return acc;
}

/** Find an exported function declaration by name and describe its params. */
export function functionShapes(ts, program, file, symbolName) {
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(file);
  if (!sf) return { error: `source file not in program: ${file}` };
  let decl = null;
  const visit = (n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === symbolName) decl = n;
    if (!decl) ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!decl) return { error: `symbol not found: ${symbolName}` };

  const params = decl.parameters.map((p) => {
    const t = checker.getTypeAtLocation(p);
    return {
      name: p.name.getText(sf),
      typeText: checker.typeToString(t),
      optional: Boolean(p.questionToken || p.initializer),
      shape: shapeOf(ts, checker, t),
    };
  });
  return { params };
}

/** Same lookup, but from a parse-only SourceFile: syntax text, no checker. */
export function functionSyntaxOnly(ts, sf, symbolName) {
  let decl = null;
  const visit = (n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === symbolName) decl = n;
    if (!decl) ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!decl) return { error: `symbol not found: ${symbolName}` };
  return {
    params: decl.parameters.map((p) => ({
      name: p.name.getText(sf),
      typeText: p.type ? p.type.getText(sf) : '(none)',
      optional: Boolean(p.questionToken || p.initializer),
    })),
  };
}
