import { describe, expect, it } from 'vitest';
import { tallyFields, type ShapeNode } from '../src/core/gen-data/shape.js';

const obj = (
  fields: Record<string, ShapeNode>,
  optional: string[] = [],
): ShapeNode => ({
  kind: 'object',
  fields: Object.fromEntries(
    Object.entries(fields).map(([k, node]) => [
      k,
      { node, optional: optional.includes(k) },
    ]),
  ),
});

describe('tallyFields', () => {
  it('counts leaves, not containers, and lists every unresolved path with its reason', () => {
    const root = obj({
      id: { kind: 'string' },
      meta: { kind: 'unresolved', reason: 'no type', typeText: '{}' },
      lines: {
        kind: 'array',
        item: obj({
          sku: { kind: 'string' },
          qty: { kind: 'number', integer: true },
        }),
      },
    });
    expect(tallyFields(root, 'order')).toEqual({
      fieldsTotal: 4,
      fieldsResolved: 3,
      unresolved: [{ path: 'order.meta', reason: 'no type' }],
    });
  });

  it('reports zero resolved when every leaf is unresolved', () => {
    const root = obj({
      a: {
        kind: 'unresolved',
        reason: '$ref not resolved in v1',
        typeText: '#/x',
      },
    });
    expect(tallyFields(root, 'x').fieldsResolved).toBe(0);
  });
});
