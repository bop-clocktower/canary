// Zero-dependency interpreter for the JSON Schema subset the canary QA
// contracts use (#1151, ADR 0035).
//
// Why a subset and not a library: the skills tree is dependency-free by
// contract (see ../parse-args.mjs), so the validator runs wherever node runs
// with nothing installed. Why interpret the schemas at all instead of
// hand-coding checks: the .schema.json files are what other teams' producers
// read, so the validator must enforce exactly those files. One deliberate
// refinement: `minLength` >= 1 also refuses a whitespace-only string (rule
// `non-blank`, #1154), which stock JSON Schema would accept. A keyword this
// file does not implement is REFUSED at load by schemaProblems() in
// schema-problems.mjs; otherwise a schema edit using it would read as
// enforced and enforce nothing.
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

export const TYPE_TESTS = {
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

/**
 * Rule `non-blank` (#1154 S4): unlike stock JSON Schema, a minimum of 1 or
 * more also refuses a whitespace-only string, so `"  "` is not "non-empty".
 */
function minLengthProblem(min, value) {
  if ([...value].length < min) return `must be at least ${min} character(s)`;
  return min >= 1 && value.trim() === '' ? 'must not be blank' : null;
}

function checkMinLength(min, value, path, ctx) {
  if (typeof value !== 'string') return;
  const problem = minLengthProblem(min, value);
  if (problem) report(ctx, path, problem);
}

/** RFC 6901: `~1` is `/` and `~0` is `~`, decoded in that order. */
function decodeSegment(seg) {
  return seg.replaceAll('~1', '/').replaceAll('~0', '~');
}

/** Own properties only: `#/constructor` must not reach Object.prototype. */
function ownChild(node, key) {
  return isPlainObject(node) && Object.hasOwn(node, key)
    ? node[key]
    : undefined;
}

/**
 * `file#/pointer`, `#/pointer` or `file`; base is the schema we are in.
 * `target.schema` is whatever the pointer reaches (undefined if nothing);
 * whether that is a schema is the caller's question.
 */
export function resolveRef(ref, base, registry) {
  const hash = ref.indexOf('#');
  const file = hash === -1 ? ref : ref.slice(0, hash);
  const pointer = hash === -1 ? '' : ref.slice(hash + 1);
  const target = { base: file || base, schema: undefined };
  if (pointer !== '' && !pointer.startsWith('/')) return target;
  target.schema = pointer
    .split('/')
    .slice(1)
    .reduce(
      (node, seg) => ownChild(node, decodeSegment(seg)),
      ownChild(registry, target.base),
    );
  return target;
}

function checkRef(ref, value, path, ctx) {
  const target = resolveRef(ref, ctx.base, ctx.registry);
  if (!isPlainObject(target.schema)) {
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

export const SUPPORTED_KEYWORDS = Object.freeze([
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
