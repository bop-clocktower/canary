import { describe, expect, it } from 'vitest';
import { extractJsonSchema } from '../src/core/gen-data/json-schema.js';

const reasonOf = (s: unknown) => {
  const n = extractJsonSchema(s);
  return n.kind === 'unresolved' ? n.reason : `resolved:${n.kind}`;
};

describe('extractJsonSchema refuses constraints it would otherwise ignore', () => {
  it.each([
    [
      { anyOf: [{ type: 'string' }, {}] },
      'union member is not a resolved scalar',
    ],
    [
      { oneOf: [{ type: 'string' }, { type: 'object' }] },
      'union member is not a resolved scalar',
    ],
    [{ anyOf: [] }, 'union member is not a resolved scalar'],
    [
      { type: 'integer', enum: [1, 2] },
      'enum is only supported on string types in this slice',
    ],
    [
      { type: 'string', enum: ['a', 1] },
      'enum is only supported on string types in this slice',
    ],
    [{ type: 'string', const: 'x' }, 'const is not supported in this slice'],
    [
      { type: 'string', pattern: '^a$' },
      'pattern is not supported in this slice',
    ],
    [
      { type: 'string', format: 'email' },
      'format "email" is not supported in this slice',
    ],
    [
      { type: 'number', exclusiveMinimum: 0 },
      'exclusiveMinimum is not supported in this slice',
    ],
    [
      { type: 'number', exclusiveMaximum: 9 },
      'exclusiveMaximum is not supported in this slice',
    ],
    [
      { type: 'number', multipleOf: 5 },
      'multipleOf is not supported in this slice',
    ],
    [
      { type: 'object', additionalProperties: { type: 'string' } },
      'additionalProperties schemas are not supported in this slice',
    ],
    [
      { type: 'object', patternProperties: { '^x': { type: 'string' } } },
      'patternProperties is not supported in this slice',
    ],
  ])('%j -> unresolved (%s)', (schema, reason) => {
    expect(reasonOf(schema)).toBe(reason);
  });

  it('still resolves a boolean additionalProperties and a date format', () => {
    expect(reasonOf({ type: 'object', additionalProperties: false })).toBe(
      'resolved:object',
    );
    expect(extractJsonSchema({ type: 'string', format: 'date' })).toEqual({
      kind: 'date',
      dateOnly: true,
    });
  });

  it('keeps a __proto__ property as an own field', () => {
    const n = extractJsonSchema(
      JSON.parse(
        '{"type":"object","properties":{"__proto__":{"type":"string"}}}',
      ),
    );
    expect(n.kind === 'object' && Object.keys(n.fields)).toEqual(['__proto__']);
  });
});

describe('extractJsonSchema abstains, never guesses', () => {
  it.each([
    [{}, 'no type declared'],
    [true, 'no type declared'],
    [{ $ref: '#/$defs/Money' }, '$ref is not resolved in this slice'],
    [
      { type: ['string', 'null'] },
      'type arrays are not supported in this slice',
    ],
    [{ allOf: [{ type: 'string' }] }, 'allOf is not supported in this slice'],
    [
      { type: 'array', items: [{ type: 'string' }] },
      'tuple items are not supported in this slice',
    ],
    [{ type: 'array' }, 'array has no items schema'],
    [{ type: 'null' }, 'type "null" has no ShapeNode kind'],
    [{ type: 'wat' }, 'unknown type "wat"'],
    [
      { type: 'string', not: { const: 'x' } },
      'conditional schemas are not supported in this slice',
    ],
    [
      { type: 'string', if: { minLength: 1 } },
      'conditional schemas are not supported in this slice',
    ],
  ])('%j -> unresolved (%s)', (schema, reason) => {
    expect(reasonOf(schema)).toBe(reason);
  });

  it('keeps the original schema text for the report', () => {
    const n = extractJsonSchema({ $ref: '#/$defs/Money' });
    expect(n).toMatchObject({
      kind: 'unresolved',
      typeText: '{"$ref":"#/$defs/Money"}',
    });
  });
});

describe('extractJsonSchema resolves the supported subset', () => {
  it('reads the Order shape with required/optional and nested arrays', () => {
    const n = extractJsonSchema({
      type: 'object',
      required: ['id', 'total', 'lines'],
      properties: {
        id: { type: 'string', minLength: 1 },
        total: { type: 'number', minimum: 0 },
        lines: {
          type: 'array',
          items: {
            type: 'object',
            required: ['sku'],
            properties: {
              sku: { type: 'string' },
              qty: { type: 'integer', minimum: 1, maximum: 99 },
            },
          },
        },
        coupon: { type: 'string' },
        placedAt: { type: 'string', format: 'date-time' },
        status: { type: 'string', enum: ['open', 'paid'] },
        gift: { type: 'boolean' },
        ref: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
      },
    });
    expect(n).toEqual({
      kind: 'object',
      fields: {
        id: { node: { kind: 'string', minLength: 1 }, optional: false },
        total: {
          node: { kind: 'number', integer: false, min: 0 },
          optional: false,
        },
        lines: {
          node: {
            kind: 'array',
            item: {
              kind: 'object',
              fields: {
                sku: { node: { kind: 'string' }, optional: false },
                qty: {
                  node: { kind: 'number', integer: true, min: 1, max: 99 },
                  optional: true,
                },
              },
            },
          },
          optional: false,
        },
        coupon: { node: { kind: 'string' }, optional: true },
        placedAt: { node: { kind: 'date' }, optional: true },
        status: {
          node: { kind: 'string', enum: ['open', 'paid'] },
          optional: true,
        },
        gift: { node: { kind: 'boolean' }, optional: true },
        ref: {
          node: {
            kind: 'union',
            members: [{ kind: 'string' }, { kind: 'number', integer: true }],
          },
          optional: true,
        },
      },
    });
  });
});
