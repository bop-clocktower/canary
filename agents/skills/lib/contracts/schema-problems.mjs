// Load-time audit of the canary QA contract schemas (#1151, ADR 0035).
//
// schema-check.mjs enforces a declared keyword SUBSET. This module finds
// every way a schema could load cleanly yet enforce less than it reads as
// enforcing: an unsupported keyword, an unknown type name, an invalid
// pattern, a misplaced `$id`, or a `$ref` that resolves to nothing, to
// something that is not a schema, or round in a loop. validate.mjs refuses
// to run at all while this reports anything.

import {
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

function walkSchema(node, at, ctx) {
  if (!isPlainObject(node)) {
    ctx.problems.push(`${at}: a schema must be an object`);
    return;
  }
  ctx.nodes.add(node);
  for (const [keyword, arg] of Object.entries(node)) {
    const where = `${at}/${keyword}`;
    if (!SUPPORTED_KEYWORDS.includes(keyword)) {
      ctx.problems.push(`${where}: unsupported keyword`);
    } else if (Object.hasOwn(WALKERS, keyword)) {
      WALKERS[keyword](arg, where, { ...ctx, at: { node, base: ctx.base } });
    }
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
