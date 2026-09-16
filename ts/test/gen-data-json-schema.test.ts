import { describe, expect, it } from 'vitest';
import { extractJsonSchema } from '../src/core/gen-data/json-schema.js';

const reasonOf = (s: unknown) => {
  const n = extractJsonSchema(s);
  return n.kind === 'unresolved' ? n.reason : `resolved:${n.kind}`;
};

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
