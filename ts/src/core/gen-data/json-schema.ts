/** JSON Schema -> ShapeNode, the primary shape source in v1 ("D2 revisited"). */
import type { ShapeNode } from './shape.js';

type Schema = Record<string, unknown>;
const unresolved = (reason: string, s: unknown): ShapeNode => ({
  kind: 'unresolved',
  reason,
  typeText: JSON.stringify(s) ?? String(s),
});

/** Constructs this slice refuses to interpret, in check order. */
const REFUSALS: ReadonlyArray<[(s: Schema) => boolean, string]> = [
  [(s) => '$ref' in s, '$ref is not resolved in this slice'],
  [(s) => Array.isArray(s.type), 'type arrays are not supported in this slice'],
  [(s) => 'allOf' in s, 'allOf is not supported in this slice'],
  [
    (s) => 'not' in s || 'if' in s,
    'conditional schemas are not supported in this slice',
  ],
];

const isSchema = (v: unknown): v is Schema =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function extractJsonSchema(schema: unknown): ShapeNode {
  if (!isSchema(schema)) return unresolved('no type declared', schema);
  const refusal = REFUSALS.find(([hit]) => hit(schema));
  if (refusal) return unresolved(refusal[1], schema);
  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union))
    return { kind: 'union', members: union.map(extractJsonSchema) };
  return readTyped(schema);
}

/** Dispatch on a scalar `type` through the reader table. */
function readTyped(s: Schema): ShapeNode {
  if (s.type === undefined) return unresolved('no type declared', s);
  const read = KIND_READERS[String(s.type)];
  return read ? read(s) : unresolved(typeReason(s.type), s);
}

const typeReason = (t: unknown) =>
  t === 'null'
    ? 'type "null" has no ShapeNode kind'
    : `unknown type "${String(t)}"`;

const num = (v: unknown) => (typeof v === 'number' ? v : undefined);

function readString(s: Schema): ShapeNode {
  if (s.format === 'date-time' || s.format === 'date') return { kind: 'date' };
  const minLength = num(s.minLength);
  const maxLength = num(s.maxLength);
  const values = s.enum;
  const isStringEnum =
    Array.isArray(values) && values.every((v) => typeof v === 'string');
  return {
    kind: 'string',
    ...(minLength !== undefined ? { minLength } : {}),
    ...(maxLength !== undefined ? { maxLength } : {}),
    ...(isStringEnum ? { enum: values as string[] } : {}),
  };
}

function readNumber(s: Schema, integer: boolean): ShapeNode {
  const min = num(s.minimum);
  const max = num(s.maximum);
  return {
    kind: 'number',
    integer,
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
  };
}

function readArray(s: Schema): ShapeNode {
  if (s.items === undefined) return unresolved('array has no items schema', s);
  if (Array.isArray(s.items))
    return unresolved('tuple items are not supported in this slice', s);
  return { kind: 'array', item: extractJsonSchema(s.items) };
}

function readObject(s: Schema): ShapeNode {
  const props = s.properties;
  if (typeof props !== 'object' || props === null)
    return { kind: 'object', fields: {} };
  const required = Array.isArray(s.required)
    ? s.required.filter((r): r is string => typeof r === 'string')
    : [];
  const fields: Record<string, { node: ShapeNode; optional: boolean }> = {};
  for (const [k, v] of Object.entries(props as Schema))
    fields[k] = { node: extractJsonSchema(v), optional: !required.includes(k) };
  return { kind: 'object', fields };
}

const KIND_READERS: Record<string, (s: Schema) => ShapeNode> = {
  string: readString,
  integer: (s) => readNumber(s, true),
  number: (s) => readNumber(s, false),
  boolean: () => ({ kind: 'boolean' }),
  array: readArray,
  object: readObject,
};
