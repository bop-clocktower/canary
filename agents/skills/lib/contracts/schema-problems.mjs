// Load-time audit of the canary QA contract schemas (#1151, ADR 0035).
//
// schema-check.mjs enforces a declared keyword SUBSET. This module finds
// every way a schema could load cleanly yet enforce less than it reads as
// enforcing: an unsupported keyword, a keyword value of the wrong shape, an
// unknown type name, an invalid pattern, a misplaced `$id`, or a `$ref` that
// resolves to nothing, to something that is not a schema, or round in a
// loop. auditedValidator() is the only way validate.mjs gets a validator,
// so it refuses to run at all while this reports anything.

import {
  checkValue,
  isPlainObject,
  resolveRef,
  SUPPORTED_KEYWORDS,
  TYPE_TESTS,
} from './schema-check.mjs';

function patternProblem(source) {
  try {
    new RegExp(source, 'u');
    return false;
  } catch {
    return true;
  }
}

function walkChildren(arg, where, ctx) {
  for (const [name, sub] of Object.entries(arg)) {
    walkSchema(sub, `${where}/${name}`, ctx);
  }
}

function typeProblems(arg, where, ctx) {
  for (const t of Array.isArray(arg) ? arg : [arg]) {
    if (!Object.hasOwn(TYPE_TESTS, t)) {
      ctx.problems.push(`${where}: unknown type '${t}'`);
    }
  }
}

/**
 * `$id` would re-base `$ref` resolution in real JSON Schema, which this
 * interpreter does not do (it resolves against registry keys). So `$id` is
 * refused anywhere but a file root, and there it must name that file.
 */
function idProblems(arg, where, ctx) {
  if (where !== `${ctx.base}#/$id`) {
    ctx.problems.push(`${where}: $id is allowed only at a schema file root`);
  } else if (arg !== ctx.base) {
    ctx.problems.push(
      `${where}: must equal the schema file name '${ctx.base}'`,
    );
  }
}

/** Load-time walkers for keywords whose argument holds more to check. */
const WALKERS = {
  properties: walkChildren,
  $defs: walkChildren,
  items: walkSchema,
  type: typeProblems,
  pattern: (arg, where, ctx) => {
    if (patternProblem(arg)) ctx.problems.push(`${where}: invalid pattern`);
  },
  $id: idProblems,
  // Resolved after every file is walked: a ref may point into a file (or a
  // node) not yet visited, and only walked nodes count as schemas.
  $ref: (ref, where, ctx) => ctx.refs.push({ ref, where, ...ctx.at }),
};

const isStringList = (v) =>
  Array.isArray(v) && v.every((s) => typeof s === 'string');

/**
 * The value each asserting keyword must hold. schema-check.mjs trusts these
 * shapes: `enum: "abc"` would match substrings, `required: "ab"` iterate
 * characters, `minimum: "5"` coerce. `items` is shape-checked by
 * walkSchema; `const` takes any value.
 */
const ARG_SHAPES = {
  enum: [(v) => Array.isArray(v) && v.length > 0, 'a non-empty array'],
  required: [isStringList, 'an array of strings'],
  minimum: [Number.isFinite, 'a finite number'],
  minLength: [
    (v) => Number.isSafeInteger(v) && v >= 0,
    'a non-negative integer',
  ],
  properties: [isPlainObject, 'an object'],
  $defs: [isPlainObject, 'an object'],
  type: [
    (v) => typeof v === 'string' || (isStringList(v) && v.length > 0),
    'a type name or a non-empty array of type names',
  ],
  pattern: [(v) => typeof v === 'string', 'a string'],
  $ref: [(v) => typeof v === 'string', 'a string'],
};

function walkKeyword(keyword, arg, where, ctx) {
  if (!SUPPORTED_KEYWORDS.includes(keyword)) {
    ctx.problems.push(`${where}: unsupported keyword`);
    return;
  }
  const shape = Object.hasOwn(ARG_SHAPES, keyword) ? ARG_SHAPES[keyword] : null;
  if (shape && !shape[0](arg)) {
    ctx.problems.push(`${where}: must be ${shape[1]}`);
    return;
  }
  if (Object.hasOwn(WALKERS, keyword)) WALKERS[keyword](arg, where, ctx);
}

function walkSchema(node, at, ctx) {
  if (!isPlainObject(node)) {
    ctx.problems.push(`${at}: a schema must be an object`);
    return;
  }
  ctx.nodes.add(node);
  const here = { ...ctx, at: { node, base: ctx.base } };
  for (const [keyword, arg] of Object.entries(node)) {
    walkKeyword(keyword, arg, `${at}/${keyword}`, here);
  }
}

/**
 * True when following `$ref`s from `start` comes back to it: validation
 * would recurse without consuming any of the document, and never end.
 */
function returnsTo(start, edges) {
  let node = edges.get(start);
  for (let i = 0; i < edges.size && node !== undefined; i += 1) {
    if (node === start) return true;
    node = edges.get(node);
  }
  return false;
}

/** A ref must reach a walked schema node, and no ref chain may loop. */
function refProblems(refs, nodes, registry, problems) {
  const edges = new Map();
  for (const r of refs) {
    const { schema } = resolveRef(r.ref, r.base, registry);
    if (schema === undefined) {
      problems.push(`${r.where}: unresolvable $ref '${r.ref}'`);
    } else if (!nodes.has(schema)) {
      problems.push(`${r.where}: $ref '${r.ref}' does not point at a schema`);
    } else {
      edges.set(r.node, schema);
    }
  }
  for (const r of refs) {
    if (returnsTo(r.node, edges)) {
      problems.push(`${r.where}: circular $ref '${r.ref}'`);
    }
  }
}

/**
 * Every problem in a schema registry (`$id` -> parsed schema), as
 * `<file>#/<pointer>: <message>` strings. Empty = every keyword is enforced.
 */
export function schemaProblems(registry) {
  const ctx = { problems: [], registry, nodes: new Set(), refs: [] };
  for (const [id, schema] of Object.entries(registry)) {
    walkSchema(schema, `${id}#`, { ...ctx, base: id });
  }
  refProblems(ctx.refs, ctx.nodes, registry, ctx.problems);
  return ctx.problems;
}

/**
 * A validator over `registry` that exists only once the registry passes
 * schemaProblems(): a validator that silently skips part of its contract is
 * a false green, so an unenforceable schema throws here, at load.
 * @param {Record<string, object>} registry
 * @returns {(id: string, value: unknown) => {path: string, message: string}[]}
 */
export function auditedValidator(registry) {
  const problems = schemaProblems(registry);
  if (problems.length > 0) {
    throw new Error(
      `canary contracts: unenforceable schema: ${problems.join('; ')}`,
    );
  }
  return (id, value) => {
    const ctx = { registry, base: id, errors: [] };
    checkValue(registry[id], value, '$', ctx);
    return ctx.errors;
  };
}
