/**
 * Load-time refusals of the contract schema interpreter (#1151, ADR 0035):
 * every way a schema could load cleanly yet enforce nothing is a reported
 * problem. Each refusal is planted; each describe has a clean control.
 */
import { describe, it, expect } from 'vitest';

import { checkValue } from '../lib/contracts/schema-check.mjs';
import { schemaProblems } from '../lib/contracts/schema-problems.mjs';

const ID = 'p.schema.json';
const problemsOf = (schema: object, others: Record<string, object> = {}) =>
  schemaProblems({ [ID]: schema, ...others });
const withRef = (ref: string, extra: object = {}) => ({
  properties: { a: { $ref: ref } },
  $defs: { t: { type: 'string' } },
  required: ['a'],
  ...extra,
});

describe('$ref resolution: own properties only, schema targets only (I1)', () => {
  it.each(['#/constructor', '#/__proto__', '#/$defs/toString'])(
    'refuses %s, a name inherited from Object.prototype',
    (ref) => {
      expect(problemsOf(withRef(ref))).toEqual([
        `${ID}#/properties/a/$ref: unresolvable $ref '${ref}'`,
      ]);
    },
  );

  it.each(['#/required', '#/$defs/t/type', '#/properties', '#/$defs'])(
    'refuses %s, which resolves to something that is not a schema',
    (ref) => {
      expect(problemsOf(withRef(ref))).toEqual([
        `${ID}#/properties/a/$ref: $ref '${ref}' does not point at a schema`,
      ]);
    },
  );

  it('refuses a file part naming an Object.prototype member', () => {
    expect(problemsOf(withRef('constructor#/$defs/t'))).toEqual([
      `${ID}#/properties/a/$ref: unresolvable $ref 'constructor#/$defs/t'`,
    ]);
  });

  it('refuses a fragment that is not a JSON pointer', () => {
    expect(problemsOf(withRef('#t'))).toEqual([
      `${ID}#/properties/a/$ref: unresolvable $ref '#t'`,
    ]);
  });

  it('decodes ~1 as / and ~0 as ~ in pointer segments', () => {
    const schema = {
      properties: {
        a: { $ref: '#/$defs/x~1y' },
        b: { $ref: '#/$defs/m~0n' },
      },
      $defs: { 'x/y': { type: 'string' }, 'm~n': { type: 'integer' } },
    };
    expect(problemsOf(schema)).toEqual([]);
    const ctx = { registry: { [ID]: schema }, base: ID, errors: [] as any[] };
    checkValue(schema, { a: 1, b: 'x' }, '$', ctx);
    expect(ctx.errors.map((e) => e.path)).toEqual(['a', 'b']);
  });

  it('throws at validation time instead of enforcing nothing', () => {
    const schema = withRef('#/constructor');
    const ctx = { registry: { [ID]: schema }, base: ID, errors: [] };
    expect(() => checkValue(schema, { a: 1 }, '$', ctx)).toThrow(
      /unresolvable \$ref '#\/constructor'/,
    );
  });

  it('resolves a whole-file ref and a pointer into another file (control)', () => {
    const other = { $id: 'o.schema.json', $defs: { s: { type: 'string' } } };
    const schema = withRef('o.schema.json#/$defs/s', {
      items: { $ref: 'o.schema.json' },
    });
    expect(problemsOf(schema, { 'o.schema.json': other })).toEqual([]);
  });
});

describe('circular $ref is a load problem, not a stack overflow (S6)', () => {
  it('refuses a schema that refers to itself', () => {
    expect(problemsOf({ $ref: '#' })).toEqual([
      `${ID}#/$ref: circular $ref '#'`,
    ]);
  });

  it('refuses a cycle through $defs', () => {
    expect(
      problemsOf({
        $ref: '#/$defs/a',
        $defs: { a: { $ref: '#/$defs/b' }, b: { $ref: '#/$defs/a' } },
      }),
    ).toEqual([
      `${ID}#/$defs/a/$ref: circular $ref '#/$defs/b'`,
      `${ID}#/$defs/b/$ref: circular $ref '#/$defs/a'`,
    ]);
  });

  it('allows recursion that descends into the document (control)', () => {
    const tree = {
      type: 'object',
      properties: { children: { type: 'array', items: { $ref: '#' } } },
    };
    expect(problemsOf(tree)).toEqual([]);
  });
});

describe('$id only at a schema file root, naming that file (I1)', () => {
  it('refuses $id below the root', () => {
    expect(problemsOf({ $defs: { t: { $id: 'q.schema.json' } } })).toEqual([
      `${ID}#/$defs/t/$id: $id is allowed only at a schema file root`,
    ]);
  });

  it('refuses a root $id that differs from the file name', () => {
    expect(problemsOf({ $id: 'other.schema.json' })).toEqual([
      `${ID}#/$id: must equal the schema file name '${ID}'`,
    ]);
  });

  it('accepts a root $id equal to the file name (control)', () => {
    expect(problemsOf({ $id: ID, type: 'object' })).toEqual([]);
  });
});

describe('keyword values are shape-checked at load (I2)', () => {
  // Each of these used to load cleanly and then misbehave: enum "abc" did
  // substring matching, required "ab" iterated characters, minimum "5"
  // coerced, properties [] walked nothing.
  it.each([
    ['enum', 'abc', 'a non-empty array'],
    ['enum', [], 'a non-empty array'],
    ['required', 'ab', 'an array of strings'],
    ['required', ['a', 1], 'an array of strings'],
    ['minimum', '5', 'a finite number'],
    ['minimum', null, 'a finite number'],
    ['minLength', 'x', 'a non-negative integer'],
    ['minLength', -1, 'a non-negative integer'],
    ['minLength', 1.5, 'a non-negative integer'],
    ['properties', [], 'an object'],
    ['$defs', [], 'an object'],
    ['type', [], 'a type name or a non-empty array of type names'],
    ['type', 5, 'a type name or a non-empty array of type names'],
    ['pattern', 5, 'a string'],
    ['$ref', 5, 'a string'],
  ])('refuses %s: %j', (keyword, arg, shape) => {
    expect(problemsOf({ [keyword]: arg })).toEqual([
      `${ID}#/${keyword}: must be ${shape}`,
    ]);
  });

  it('refuses a non-object items (tuple form is not supported)', () => {
    expect(problemsOf({ items: [{ type: 'string' }] })).toEqual([
      `${ID}#/items: a schema must be an object`,
    ]);
  });

  it('accepts every keyword with a well-shaped value (control)', () => {
    expect(
      problemsOf({
        type: ['object', 'null'],
        required: ['a'],
        properties: {
          a: { type: 'string', minLength: 0, pattern: '^a', enum: ['a'] },
          b: { type: 'number', minimum: -1.5, const: { any: ['thing'] } },
          c: { type: 'array', items: { $ref: '#/$defs/t' } },
        },
        $defs: { t: { const: null } },
      }),
    ).toEqual([]);
  });
});
