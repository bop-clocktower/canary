import { describe, expect, it } from 'vitest';
import { generateFixtureSet } from '../src/core/gen-data/generate.js';
import { extractJsonSchema } from '../src/core/gen-data/json-schema.js';
import { mulberry32 } from '../src/core/gen-data/prng.js';
import type { ShapeNode } from '../src/core/gen-data/shape.js';
import { defaultValue, leafCases } from '../src/core/gen-data/strategies.js';

describe('leafCases', () => {
  it('boundary for a non-integer number includes a fractional value (SOUND-003)', () => {
    const cases = leafCases(
      { kind: 'number', integer: false, min: 0, max: 100 },
      'total',
    );
    const boundary = cases
      .filter((c) => c.category === 'boundary')
      .map((c) => c.value);
    expect(boundary).toEqual(
      expect.arrayContaining([
        0,
        -1,
        1,
        Number.MAX_SAFE_INTEGER,
        Number.MIN_SAFE_INTEGER,
        101,
      ]),
    );
    expect(
      boundary.some((v) => typeof v === 'number' && !Number.isInteger(v)),
    ).toBe(true);
  });
  it('an integer field gets no fractional boundary', () => {
    const cases = leafCases({ kind: 'number', integer: true }, 'qty');
    expect(
      cases.every(
        (c) => typeof c.value !== 'number' || Number.isInteger(c.value),
      ),
    ).toBe(true);
  });
  it('strings get empty, whitespace, maxLength+1 and non-ASCII/RTL/emoji literals', () => {
    const values = leafCases({ kind: 'string', maxLength: 3 }, 'code').map(
      (c) => c.value,
    );
    expect(values).toEqual(expect.arrayContaining(['', '   ', 'xxxx']));
    expect(values.some((v) => typeof v === 'string' && /[֐-׿]/.test(v))).toBe(
      true,
    );
  });
  it('dates are fixed ISO-8601 UTC literals with an explicit Z, incl. leap-day', () => {
    const values = leafCases({ kind: 'date' }, 'placedAt').map((c) => c.value);
    expect(values).toContain('2024-02-29T23:59:59Z');
    expect(
      values
        .filter((v) => typeof v === 'string')
        .every((v) => String(v).endsWith('Z') || !/^\d{4}-/.test(String(v))),
    ).toBe(true);
  });
  it('unexpected-shape offers wrong primitive type and null', () => {
    const cats = leafCases({ kind: 'string' }, 'id').filter(
      (c) => c.category === 'unexpected-shape',
    );
    expect(cats.map((c) => c.value)).toEqual(expect.arrayContaining([null, 0]));
  });
  it('a union drops a member-0 case another member accepts (#1039)', () => {
    const first: ShapeNode = { kind: 'string' };
    const union: ShapeNode = {
      kind: 'union',
      members: [first, { kind: 'number', integer: false }],
    };
    const values = leafCases(union, 'ref').map((c) => c.value);
    // The string member contributes `0` as unexpected-shape, but the number
    // member accepts it -- asserting a rejection the schema would allow.
    expect(leafCases(first, 'ref').map((c) => c.value)).toContain(0);
    expect(values).not.toContain(0);
    // null is rejected by both members, so it survives the filter.
    expect(values).toContain(null);
  });
  it.each([
    [[{ kind: 'string' }, { kind: 'number', integer: true }]],
    [[{ kind: 'number', integer: true, min: 1, max: 9 }, { kind: 'string' }]],
    [[{ kind: 'date' }, { kind: 'string' }]],
    [[{ kind: 'boolean' }, { kind: 'number', integer: false }]],
  ] as unknown as Array<[ShapeNode[]]>)(
    'a union of %j emits only member-0 cases, minus sibling-accepted ones',
    (members) => {
      const first = members[0] as ShapeNode;
      const ownValues = leafCases(first, 'ref').map((c) => c.value);
      const unionValues = leafCases({ kind: 'union', members }, 'ref').map(
        (c) => c.value,
      );
      // Subset: the filter only ever removes.
      for (const v of unionValues) expect(ownValues).toContainEqual(v);
      // Any dropped value must be one a sibling can hold: it appears as a
      // legitimate value of some other member's own kind.
      const dropped = ownValues.filter((v) => !unionValues.includes(v));
      // Non-vacuity: every row above is chosen so member 0 contributes at
      // least one case the sibling accepts. Without this the two assertions
      // hold trivially when nothing is filtered -- a zero denominator, which
      // is an abstention rather than a pass.
      expect(dropped.length).toBeGreaterThan(0);
      for (const v of dropped)
        expect(
          members
            .slice(1)
            .some((m) =>
              typeof v === (m as { kind: string }).kind
                ? true
                : (m as { kind: string }).kind === 'date' &&
                  typeof v === 'string',
            ),
        ).toBe(true);
    },
  );
  it('keeps every case when all members share the same constraints', () => {
    const member: ShapeNode = {
      kind: 'number',
      integer: true,
      min: 1,
      max: 9,
    };
    const union: ShapeNode = { kind: 'union', members: [member, member] };
    expect(leafCases(union, 'ref').map((c) => c.value)).toEqual(
      leafCases(member, 'ref').map((c) => c.value),
    );
  });
});

describe('defaultValue', () => {
  it('is seed-dependent for strings and non-boundary numbers', () => {
    const s = { kind: 'string' } as const;
    expect(defaultValue(s, 'id', mulberry32(765))).not.toBe(
      defaultValue(s, 'id', mulberry32(1)),
    );
  });
  it('respects min/max and integer-ness', () => {
    const v = defaultValue(
      { kind: 'number', integer: true, min: 1, max: 99 },
      'qty',
      mulberry32(765),
    );
    expect(Number.isInteger(v)).toBe(true);
    expect(v as number).toBeGreaterThanOrEqual(1);
    expect(v as number).toBeLessThanOrEqual(99);
  });
  it.each([
    [{ kind: 'number', integer: true, min: 5000 }],
    [{ kind: 'number', integer: false, min: 5000 }],
    [{ kind: 'number', integer: true, max: -20 }],
    [{ kind: 'number', integer: false, max: 0.5 }],
    [{ kind: 'number', integer: false, min: 0.001, max: 0.002 }],
    [{ kind: 'number', integer: true, min: 1.5, max: 3.5 }],
  ] as const)('stays inside the bounds of %j across seeds', (node) => {
    for (let seed = 0; seed < 50; seed++) {
      const v = defaultValue(node, 'n', mulberry32(seed)) as number;
      if ('min' in node) expect(v).toBeGreaterThanOrEqual(node.min);
      if ('max' in node) expect(v).toBeLessThanOrEqual(node.max);
      if (node.integer) expect(Number.isInteger(v)).toBe(true);
    }
  });
  it('a union defaults and plans cases from its first member', () => {
    const first: ShapeNode = { kind: 'number', integer: true, min: 1, max: 9 };
    const union: ShapeNode = {
      kind: 'union',
      members: [first, { kind: 'string' }],
    };
    const v = defaultValue(union, 'ref', mulberry32(765));
    expect(Number.isInteger(v)).toBe(true);
    expect(leafCases(union, 'ref').map((c) => c.value)).toEqual(
      leafCases(first, 'ref').map((c) => c.value),
    );
  });
  it('a date-only field defaults to YYYY-MM-DD and gets date-only cases', () => {
    const node = { kind: 'date', dateOnly: true } as const;
    expect(defaultValue(node, 'd', mulberry32(765))).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
    const dated = leafCases(node, 'd')
      .map((c) => c.value)
      .filter((v) => typeof v === 'string');
    expect(dated.length).toBeGreaterThan(0);
    expect(dated.every((v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v)))).toBe(
      true,
    );
  });
});

const ORDER = extractJsonSchema({
  type: 'object',
  required: ['id', 'total'],
  properties: {
    id: { type: 'string' },
    total: { type: 'number' },
    meta: {},
  },
});

describe('generateFixtureSet', () => {
  it('is a pure function of (shape, seed)', () => {
    expect(generateFixtureSet(ORDER, 'order', 765)).toEqual(
      generateFixtureSet(ORDER, 'order', 765),
    );
  });
  it('omits unresolved fields from the default and discloses them', () => {
    const set = generateFixtureSet(ORDER, 'order', 765);
    expect(set.defaultValue).not.toHaveProperty('meta');
    expect(set.unresolved).toEqual([
      { path: 'order.meta', reason: 'no type declared' },
    ]);
    expect([set.fieldsResolved, set.fieldsTotal]).toEqual([2, 3]);
  });
  it('never plans a case against an unresolved path', () => {
    const set = generateFixtureSet(ORDER, 'order', 765);
    expect(
      set.cases.some(
        (c) => c.name.includes('meta') && c.category !== 'unexpected-shape',
      ),
    ).toBe(false);
  });
  it('adds missing-required and extra-field whole-object cases', () => {
    const names = generateFixtureSet(ORDER, 'order', 765).cases.map(
      (c) => c.name,
    );
    expect(names).toContain('unexpected-shape: missing required id');
    expect(names).toContain('unexpected-shape: extra field');
  });
  it('reports race, partial-network and accessibility as notCovered', () => {
    expect(generateFixtureSet(ORDER, 'order', 765).notCovered).toEqual([
      { category: 'race', reason: 'not data-expressible' },
      { category: 'partial-network', reason: 'not data-expressible' },
      { category: 'accessibility', reason: 'not data-expressible' },
    ]);
  });
  it('caps cases at 50 and reports the truncation', () => {
    const wide = extractJsonSchema({
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [`f${i}`, { type: 'number' }]),
      ),
    });
    const set = generateFixtureSet(wide, 'wide', 765);
    expect(set.cases).toHaveLength(50);
    expect(set.casesTruncated).toBeGreaterThan(0);
  });
  it('includes a fractional value for a non-integer number (criterion 9)', () => {
    const vals = generateFixtureSet(ORDER, 'order', 765)
      .cases.filter((c) => c.name.includes('total'))
      .map((c) => (c.value as { total?: unknown }).total);
    expect(
      vals.some((v) => typeof v === 'number' && !Number.isInteger(v)),
    ).toBe(true);
  });
});
