/**
 * Unit contract for the canary QA contract schema interpreter (#1151, ADR 0035).
 * The interpreter enforces a declared keyword SUBSET; anything outside it is
 * refused at load by schemaProblems(), so a schema edit can never read as
 * enforced while enforcing nothing.
 */
import { describe, it, expect } from 'vitest';

import { checkValue } from '../lib/contracts/schema-check.mjs';
import { schemaProblems } from '../lib/contracts/schema-problems.mjs';

type Err = { path: string; message: string };

function check(
  schema: object,
  value: unknown,
  others: Record<string, object> = {},
): Err[] {
  const ctx = {
    registry: { 'x.schema.json': schema, ...others },
    base: 'x.schema.json',
    errors: [] as Err[],
  };
  checkValue(schema, value, '$', ctx);
  return ctx.errors;
}

describe('checkValue — keywords', () => {
  it('type: accepts a union member and names the path on a miss', () => {
    expect(check({ type: ['string', 'null'] }, null)).toEqual([]);
    expect(
      check({ properties: { a: { type: 'integer' } } }, { a: 1.5 }),
    ).toEqual([{ path: 'a', message: 'expected integer, got number' }]);
  });

  it('type: names array and null distinctly from object', () => {
    expect(check({ type: 'object' }, [])).toEqual([
      { path: '$', message: 'expected object, got array' },
    ]);
    expect(check({ type: 'object' }, null)).toEqual([
      { path: '$', message: 'expected object, got null' },
    ]);
  });

  it('required: names the missing field by its full dotted path', () => {
    const schema = {
      properties: { scope: { type: 'object', required: ['id', 'env'] } },
    };
    expect(check(schema, { scope: { id: 'x' } })).toEqual([
      { path: 'scope.env', message: 'missing required field' },
    ]);
  });

  it('items: indexes array members in the path', () => {
    expect(check({ items: { type: 'string' } }, ['a', 2])).toEqual([
      { path: '$[1]', message: 'expected string, got number' },
    ]);
  });

  it('enum and const name the allowed values', () => {
    expect(check({ enum: ['a', null] }, 'b')[0].message).toBe(
      'must be one of: "a", null',
    );
    expect(check({ const: 'canary.run/1' }, 'x')[0].message).toBe(
      'must be "canary.run/1"',
    );
  });

  it('pattern, minimum and minLength apply only to their own types', () => {
    expect(check({ pattern: '^[^@]+$' }, 'a@b')).toHaveLength(1);
    expect(check({ pattern: '^[^@]+$' }, null)).toEqual([]);
    expect(check({ minimum: 0 }, -1)[0].message).toBe('must be >= 0');
    expect(check({ minLength: 1 }, '')).toHaveLength(1);
    expect(check({ minLength: 1 }, 7)).toEqual([]);
  });

  it('minLength >= 1 refuses a whitespace-only string as blank (#1154 S4)', () => {
    const blank = [{ path: '$', message: 'must not be blank' }];
    expect(check({ minLength: 1 }, '  ')).toEqual(blank);
    expect(check({ minLength: 1 }, '\t\n')).toEqual(blank);
    expect(check({ minLength: 1 }, '')).toEqual([
      { path: '$', message: 'must be at least 1 character(s)' },
    ]);
    expect(check({ minLength: 1 }, ' x ')).toEqual([]);
    expect(check({ minLength: 0 }, '  ')).toEqual([]);
    expect(check({ type: ['string', 'null'], minLength: 1 }, null)).toEqual([]);
  });

  it('$ref resolves a local pointer and a pointer into another schema', () => {
    const local = {
      $defs: { s: { required: ['env'] } },
      properties: { a: { $ref: '#/$defs/s' } },
    };
    expect(check(local, { a: {} })).toEqual([
      { path: 'a.env', message: 'missing required field' },
    ]);
    const other = { $defs: { s: { required: ['id'] } } };
    const cross = {
      properties: { b: { $ref: 'other.schema.json#/$defs/s' } },
    };
    expect(check(cross, { b: {} }, { 'other.schema.json': other })).toEqual([
      { path: 'b.id', message: 'missing required field' },
    ]);
  });

  it('tolerates a field the schema does not declare (D3 additive minors)', () => {
    expect(check({ type: 'object', properties: {} }, { later: 1 })).toEqual([]);
  });
});

describe('schemaProblems — an unenforced keyword is refused, not ignored', () => {
  it('reports an unsupported keyword with its location (planted)', () => {
    expect(
      schemaProblems({
        'p.schema.json': {
          properties: { a: { additionalProperties: false } },
        },
      }),
    ).toEqual([
      'p.schema.json#/properties/a/additionalProperties: unsupported keyword',
    ]);
  });

  it('reports an unknown type name, a bad pattern and an unresolvable $ref', () => {
    const problems = schemaProblems({
      'p.schema.json': {
        type: 'float',
        properties: { a: { pattern: '(' }, b: { $ref: '#/$defs/missing' } },
      },
    });
    expect(problems).toEqual([
      "p.schema.json#/type: unknown type 'float'",
      'p.schema.json#/properties/a/pattern: invalid pattern',
      "p.schema.json#/properties/b/$ref: unresolvable $ref '#/$defs/missing'",
    ]);
  });

  it('reports nothing for a schema using only supported keywords (control)', () => {
    expect(
      schemaProblems({
        'p.schema.json': {
          $id: 'p.schema.json',
          type: 'object',
          required: ['a'],
          properties: { a: { $ref: '#/$defs/t' } },
          $defs: { t: { type: 'string', minLength: 1 } },
        },
      }),
    ).toEqual([]);
  });
});
