/**
 * Per-leaf value strategies for the data-expressible categories (#765). Every
 * value here is computed at emit time and baked into the fixture as a literal.
 */
import type { ShapeNode } from './shape.js';

export type Category = 'boundary' | 'locale-timezone' | 'unexpected-shape';
export interface LeafCase {
  category: Category;
  label: string;
  value: unknown;
}
type Rng = () => number;
type Leaf = Exclude<ShapeNode, { kind: 'object' | 'array' | 'unresolved' }>;
type Of<K extends Leaf['kind']> = Extract<Leaf, { kind: K }>;
type Raw = [Category, unknown];

const LABEL_MAX = 60;
const DAY_MS = 86_400_000;
const SPAN = 999; // width of the default range when only one bound is declared
const BASE_DAY_MS = Date.UTC(2024, 0, 1); // fixed epoch, not a clock read
const LOCALE_STRINGS = ['café über', 'שלום', '\u{1F426} canary'];
const TZ_LITERALS = [
  '2024-02-29T23:59:59Z',
  '2024-03-10T07:00:00Z',
  '1970-01-01T00:00:00Z',
];

const hex = (rng: Rng) =>
  Math.floor(rng() * 0xffffff)
    .toString(16)
    .padStart(6, '0');

function defaultString(n: Of<'string'>, field: string, rng: Rng): string {
  if (n.enum && n.enum.length > 0)
    return n.enum[Math.floor(rng() * n.enum.length)] as string;
  const raw = `synthetic-${field}-${hex(rng)}`.padEnd(n.minLength ?? 0, 'x');
  return n.maxLength === undefined ? raw : raw.slice(0, n.maxLength);
}

/** A default range that always sits inside whichever bounds are declared. */
function numberRange(n: Of<'number'>): [number, number] {
  const lo = n.min ?? Math.min(1, (n.max ?? 1000) - SPAN);
  const hi = n.max ?? Math.max(1000, lo + SPAN);
  return n.integer ? [Math.ceil(lo), Math.floor(hi)] : [lo, hi];
}

function defaultNumber(n: Of<'number'>, _field: string, rng: Rng): number {
  const [lo, hi] = numberRange(n);
  if (n.integer) return lo + Math.floor(rng() * Math.max(0, hi - lo + 1));
  // Rounding to cents can step past a fractional bound, so clamp after it.
  const v = Math.round((lo + rng() * (hi - lo)) * 100) / 100;
  return Math.min(hi, Math.max(lo, v));
}

function defaultDate(n: Of<'date'>, _field: string, rng: Rng): string {
  const iso = new Date(
    BASE_DAY_MS + Math.floor(rng() * 366) * DAY_MS,
  ).toISOString();
  return n.dateOnly ? iso.slice(0, 10) : iso;
}

const DEFAULTS: {
  [K in Leaf['kind']]: (n: Of<K>, field: string, rng: Rng) => unknown;
} = {
  string: defaultString,
  number: defaultNumber,
  boolean: (_n, _f, rng) => rng() < 0.5,
  date: defaultDate,
  union: (n, field, rng) => defaultValue(n.members[0], field, rng),
};

/** Seeded default for a leaf; `undefined` for a container or unresolved node. */
export function defaultValue(
  node: ShapeNode | undefined,
  field: string,
  rng: Rng,
): unknown {
  if (node === undefined || !(node.kind in DEFAULTS)) return undefined;
  const fn = DEFAULTS[node.kind as Leaf['kind']] as (
    n: Leaf,
    field: string,
    rng: Rng,
  ) => unknown;
  return fn(node as Leaf, field, rng);
}

function numberCases(n: Of<'number'>): Raw[] {
  const values: number[] = [
    0,
    -1,
    1,
    Number.MAX_SAFE_INTEGER,
    Number.MIN_SAFE_INTEGER,
  ];
  if (n.min !== undefined) values.push(n.min - 1);
  if (n.max !== undefined) values.push(n.max + 1);
  if (!n.integer) values.push(0.5);
  const raw: Raw[] = values.map((v) => ['boundary', v]);
  return [...raw, ['unexpected-shape', null], ['unexpected-shape', '0']];
}

function stringCases(n: Of<'string'>): Raw[] {
  const raw: Raw[] = [
    ['boundary', ''],
    ['boundary', '   '],
  ];
  if (n.maxLength !== undefined)
    raw.push(['boundary', 'x'.repeat(n.maxLength + 1)]);
  for (const s of LOCALE_STRINGS) raw.push(['locale-timezone', s]);
  if (n.enum) raw.push(['unexpected-shape', 'not-in-enum']);
  return [...raw, ['unexpected-shape', null], ['unexpected-shape', 0]];
}

const dateCases = (n: Of<'date'>): Raw[] => [
  ...TZ_LITERALS.map((s): Raw => [
    'locale-timezone',
    n.dateOnly ? s.slice(0, 10) : s,
  ]),
  ['unexpected-shape', null],
  ['unexpected-shape', 0],
];

const CASES: { [K in Leaf['kind']]: (n: Of<K>) => Raw[] } = {
  string: stringCases,
  number: numberCases,
  boolean: () => [
    ['unexpected-shape', null],
    ['unexpected-shape', 0],
  ],
  date: dateCases,
  union: (n) => rawCases(n.members[0]),
};

function rawCases(node: ShapeNode | undefined): Raw[] {
  if (node === undefined || !(node.kind in CASES)) return [];
  const fn = CASES[node.kind as Leaf['kind']] as (n: Leaf) => Raw[];
  return fn(node as Leaf);
}

const label = (category: Category, field: string, value: unknown) =>
  `${category}: ${field} = ${JSON.stringify(value)}`.slice(0, LABEL_MAX);

/** Every planned case for one resolved leaf, in a fixed order. */
export function leafCases(node: ShapeNode, field: string): LeafCase[] {
  return rawCases(node).map(([category, value]) => ({
    category,
    label: label(category, field, value),
    value,
  }));
}
