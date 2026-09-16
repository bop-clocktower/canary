/**
 * ShapeNode + seed -> FixtureSet (#765). A pure function of its inputs: one
 * mulberry32 stream, walked in `Object.keys` order, so the same shape and seed
 * always plan the same default and the same cases.
 */
import { mulberry32 } from './prng.js';
import { tallyFields, type FieldTally, type ShapeNode } from './shape.js';
import { defaultValue, leafCases, type Category } from './strategies.js';

const CASE_CAP = 50;
const CATEGORY_ORDER: Category[] = [
  'boundary',
  'locale-timezone',
  'unexpected-shape',
];
const NOT_COVERED = ['race', 'partial-network', 'accessibility'].map(
  (category) => ({ category, reason: 'not data-expressible' }),
);

export interface FixtureCase {
  name: string;
  category: Category;
  value: unknown;
}
export interface FixtureSet extends FieldTally {
  name: string;
  seed: number;
  defaultValue: Record<string, unknown>;
  cases: FixtureCase[];
  casesTruncated: number;
  categoriesCovered: Category[];
  notCovered: { category: string; reason: string }[];
}

type Rng = () => number;
type Segment = string | 0;
interface LeafPath {
  segments: Segment[];
  display: string;
  node: ShapeNode;
}

/** An own data property even for `__proto__`, which assignment would not make. */
function setOwn(target: object, key: string | number, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function walkDefault(node: ShapeNode, field: string, rng: Rng): unknown {
  if (node.kind === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, f] of Object.entries(node.fields)) {
      const v = walkDefault(f.node, k, rng);
      if (v !== undefined) setOwn(out, k, v);
    }
    return out;
  }
  if (node.kind === 'array') {
    const item = walkDefault(node.item, field, rng);
    return item === undefined ? [] : [item];
  }
  return defaultValue(node, field, rng);
}

function resolvedLeafPaths(
  node: ShapeNode,
  segments: Segment[],
  display: string,
): LeafPath[] {
  if (node.kind === 'unresolved') return [];
  if (node.kind === 'array')
    return resolvedLeafPaths(node.item, [...segments, 0], `${display}[]`);
  if (node.kind !== 'object') return [{ segments, display, node }];
  return Object.entries(node.fields).flatMap(([k, f]) =>
    resolvedLeafPaths(
      f.node,
      [...segments, k],
      display ? `${display}.${k}` : k,
    ),
  );
}

function withPath(
  base: Record<string, unknown>,
  segments: Segment[],
  value: unknown,
): Record<string, unknown> {
  const root = structuredClone(base);
  let cursor: Record<string | number, unknown> = root;
  for (const seg of segments.slice(0, -1)) {
    const next = cursor[seg];
    if (typeof next !== 'object' || next === null) return root;
    cursor = next as Record<string | number, unknown>;
  }
  setOwn(cursor, segments[segments.length - 1] as Segment, value);
  return root;
}

function wholeObjectCases(
  root: ShapeNode,
  base: Record<string, unknown>,
): FixtureCase[] {
  const cases: FixtureCase[] = [];
  const fields = root.kind === 'object' ? root.fields : {};
  for (const [k, f] of Object.entries(fields)) {
    if (f.optional || !(k in base)) continue;
    const value = structuredClone(base);
    delete value[k];
    cases.push(unexpected(`missing required ${k}`, value));
  }
  cases.push(unexpected('extra field', { ...base, __unexpected: true }));
  cases.push(unexpected('over-nested', { value: base }));
  return cases;
}

const unexpected = (what: string, value: unknown): FixtureCase => ({
  name: `unexpected-shape: ${what}`,
  category: 'unexpected-shape',
  value,
});

export function generateFixtureSet(
  root: ShapeNode,
  name: string,
  seed: number,
): FixtureSet {
  const rng = mulberry32(seed);
  const walked = walkDefault(root, name, rng);
  const base = (
    typeof walked === 'object' && walked !== null ? walked : {}
  ) as Record<string, unknown>;
  const all: FixtureCase[] = resolvedLeafPaths(root, [], '').flatMap((leaf) =>
    leafCases(leaf.node, leaf.display).map((c) => ({
      name: c.label,
      category: c.category,
      value: withPath(base, leaf.segments, c.value),
    })),
  );
  all.push(...wholeObjectCases(root, base));
  const cases = all.slice(0, CASE_CAP);
  const present = new Set(cases.map((c) => c.category));
  return {
    ...tallyFields(root, name),
    name,
    seed,
    defaultValue: base,
    cases,
    casesTruncated: all.length - cases.length,
    categoriesCovered: CATEGORY_ORDER.filter((c) => present.has(c)),
    notCovered: NOT_COVERED.map((n) => ({ ...n })),
  };
}
