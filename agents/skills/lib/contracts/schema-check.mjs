// Zero-dependency interpreter for the JSON Schema subset the canary QA
// contracts use (#1151, ADR 0035).
//
// Why a subset and not a library: the skills tree is dependency-free by
// contract (see ../parse-args.mjs), so the validator runs wherever node runs
// with nothing installed. Why interpret the schemas at all instead of
// hand-coding checks: the .schema.json files are what other teams' producers
// read, so the validator must enforce exactly those files. A keyword this
// file does not implement is REFUSED at load by schemaProblems(); otherwise a
// schema edit using it would read as enforced and enforce nothing.
//
// Unknown FIELDS in a document are tolerated (D3: a minor version adds
// optional fields), which is why `additionalProperties` is not supported.

/** Keywords that carry no assertion; allowed anywhere, never evaluated. */
const ANNOTATIONS = [
  '$schema',
  '$id',
  '$comment',
  'title',
  'description',
  '$defs',
];

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const TYPE_TESTS = {
  null: (v) => v === null,
  boolean: (v) => typeof v === 'boolean',
  integer: (v) => Number.isInteger(v),
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  string: (v) => typeof v === 'string',
  array: (v) => Array.isArray(v),
  object: (v) => isPlainObject(v),
};

function describeType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** `scope` + `env` -> `scope.env`; the document root is `$`. */
function childPath(path, key) {
  return path === '$' ? key : `${path}.${key}`;
}

function report(ctx, path, message) {
  ctx.errors.push({ path, message });
}

function asList(arg) {
  return Array.isArray(arg) ? arg : [arg];
}

function checkType(expected, value, path, ctx) {
  const types = asList(expected);
  if (types.some((t) => TYPE_TESTS[t](value))) return;
  report(
    ctx,
    path,
    `expected ${types.join(' or ')}, got ${describeType(value)}`,
  );
}

function checkRequired(keys, value, path, ctx) {
  if (!isPlainObject(value)) return;
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      report(ctx, childPath(path, key), 'missing required field');
    }
  }
}

function checkProperties(props, value, path, ctx) {
  if (!isPlainObject(value)) return;
  for (const [key, sub] of Object.entries(props)) {
    if (Object.hasOwn(value, key)) {
      checkValue(sub, value[key], childPath(path, key), ctx);
    }
  }
}

function checkItems(sub, value, path, ctx) {
  if (!Array.isArray(value)) return;
  value.forEach((item, i) => checkValue(sub, item, `${path}[${i}]`, ctx));
}

function checkEnum(allowed, value, path, ctx) {
  if (allowed.includes(value)) return;
  const names = allowed.map((a) => JSON.stringify(a)).join(', ');
  report(ctx, path, `must be one of: ${names}`);
}

function checkConst(expected, value, path, ctx) {
  if (value === expected) return;
  report(ctx, path, `must be ${JSON.stringify(expected)}`);
}

function checkPattern(source, value, path, ctx) {
  if (typeof value !== 'string' || new RegExp(source, 'u').test(value)) return;
  report(ctx, path, `does not match the pattern ${source}`);
}

function checkMinimum(min, value, path, ctx) {
  if (typeof value !== 'number' || value >= min) return;
  report(ctx, path, `must be >= ${min}`);
}

function checkMinLength(min, value, path, ctx) {
  if (typeof value !== 'string' || [...value].length >= min) return;
  report(ctx, path, `must be at least ${min} character(s)`);
}

/** `file#/pointer`, `#/pointer` or `file`; base is the schema we are in. */
function resolveRef(ref, base, registry) {
  const hash = ref.indexOf('#');
  const file = hash === -1 ? ref : ref.slice(0, hash);
  const pointer = hash === -1 ? '' : ref.slice(hash + 1);
  const target = { base: file || base };
  target.schema = pointer
    .split('/')
    .filter(Boolean)
    .reduce(
      (node, seg) => (isPlainObject(node) ? node[seg] : undefined),
      registry[target.base],
    );
  return target;
}

function checkRef(ref, value, path, ctx) {
  const target = resolveRef(ref, ctx.base, ctx.registry);
  if (target.schema === undefined) {
    throw new Error(`schema-check: unresolvable $ref '${ref}'`);
  }
  checkValue(target.schema, value, path, { ...ctx, base: target.base });
}

const CHECKS = {
  type: checkType,
  required: checkRequired,
  properties: checkProperties,
  items: checkItems,
  enum: checkEnum,
  const: checkConst,
  pattern: checkPattern,
  minimum: checkMinimum,
  minLength: checkMinLength,
  $ref: checkRef,
};

const SUPPORTED_KEYWORDS = Object.freeze([
  ...ANNOTATIONS,
  ...Object.keys(CHECKS),
]);

/**
 * Validate `value` against `schema`, appending `{path, message}` to
 * `ctx.errors`. `ctx` = `{ registry, base, errors }`: registry maps a
 * schema `$id` to its parsed schema, base is the `$id` refs resolve against.
 */
export function checkValue(schema, value, path, ctx) {
  for (const [keyword, arg] of Object.entries(schema)) {
    if (Object.hasOwn(CHECKS, keyword)) {
      CHECKS[keyword](arg, value, path, ctx);
    }
  }
}

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
  for (const t of asList(arg)) {
    if (!Object.hasOwn(TYPE_TESTS, t)) {
      ctx.problems.push(`${where}: unknown type '${t}'`);
    }
  }
}

function walkKeyword(keyword, arg, where, ctx) {
  if (keyword === 'properties' || keyword === '$defs') {
    walkChildren(arg, where, ctx);
  } else if (keyword === 'items') {
    walkSchema(arg, where, ctx);
  } else if (keyword === 'type') {
    typeProblems(arg, where, ctx);
  } else if (keyword === 'pattern' && patternProblem(arg)) {
    ctx.problems.push(`${where}: invalid pattern`);
  } else if (keyword === '$ref') {
    if (resolveRef(arg, ctx.base, ctx.registry).schema === undefined) {
      ctx.problems.push(`${where}: unresolvable $ref '${arg}'`);
    }
  }
}

function walkSchema(node, at, ctx) {
  if (!isPlainObject(node)) {
    ctx.problems.push(`${at}: a schema must be an object`);
    return;
  }
  for (const [keyword, arg] of Object.entries(node)) {
    const where = `${at}/${keyword}`;
    if (SUPPORTED_KEYWORDS.includes(keyword)) {
      walkKeyword(keyword, arg, where, ctx);
    } else {
      ctx.problems.push(`${where}: unsupported keyword`);
    }
  }
}

/**
 * Everything in a schema registry that would make a schema read as enforced
 * while enforcing less: unsupported keywords, unknown type names, invalid
 * patterns, unresolvable `$ref`s. Empty = every keyword is enforced.
 */
export function schemaProblems(registry) {
  const problems = [];
  for (const [id, schema] of Object.entries(registry)) {
    walkSchema(schema, `${id}#`, { problems, registry, base: id });
  }
  return problems;
}
