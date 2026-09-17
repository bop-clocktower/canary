import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { emitVitest } from '../src/core/gen-data/emit-vitest.js';
import { generateFixtureSet } from '../src/core/gen-data/generate.js';
import { extractJsonSchema } from '../src/core/gen-data/json-schema.js';

const shape = extractJsonSchema({
  type: 'object',
  required: ['id', 'meta'],
  properties: {
    id: { type: 'string' },
    total: { type: 'number' },
    meta: {},
  },
});
const text = () =>
  emitVitest(
    shape,
    generateFixtureSet(shape, 'order', 765),
    'fixtures/order.schema.json',
  );

describe('emitVitest with hostile schema text', () => {
  const INJECT = 'line\nexport const pwned = 1;';
  const BAD_FORMAT = 'x\nexport const pwned2 = 2;';
  const hostile = extractJsonSchema(
    JSON.parse(
      JSON.stringify({
        type: 'object',
        properties: {
          [INJECT]: {},
          fmt: { type: 'string', format: BAD_FORMAT },
          "it's\\back*/": { type: 'string' },
          sep: { type: 'string', enum: ['a b', "q'\n"] },
        },
      }),
    ).valueOf(),
  );
  // `__proto__` has to arrive the way JSON.parse delivers it: as an own key.
  const withProto = extractJsonSchema(
    JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"},"id":{"type":"string"}}}',
    ),
  );
  const emit = (node: typeof hostile, name: string) =>
    emitVitest(
      node,
      generateFixtureSet(node, name, 765),
      'dir\n// evil source.json',
    );
  const load = (text: string) => {
    const js = ts.transpileModule(text, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    // Evaluate the generator's own output in an isolated context: the point is
    // to prove what the emitted text DOES, not what it looks like.
    const exports: Record<string, unknown> = {};
    runInNewContext(js, { exports });
    return exports as Record<string, (o?: object) => Record<string, unknown>>;
  };

  it('keeps schema text out of code position (comments, strings, keys)', () => {
    const text = emit(hostile, 'hostile');
    const lines = text.split('\n');
    expect(lines.some((l) => /^export const pwned/.test(l))).toBe(false);
    expect(lines.filter((l) => l.startsWith('//')).length).toBe(
      text.split('\n').findIndex((l) => l === ''),
    );
    const out = ts.transpileModule(text, {
      reportDiagnostics: true,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    });
    expect(out.diagnostics?.map((d) => d.messageText)).toEqual([]);
    const mod = load(text);
    expect(Object.keys(mod).sort()).toEqual(['buildHostile', 'hostileCases']);
    expect(() => mod.buildHostile!()).toThrow(/is unresolved/);
  });

  it('a __proto__ field is an own property of the built value', () => {
    const built = load(emit(withProto, 'proto')).buildProto!();
    expect(Object.hasOwn(built, '__proto__')).toBe(true);
    expect(
      typeof Object.getOwnPropertyDescriptor(built, '__proto__')?.value,
    ).toBe('string');
  });

  it('renders a union type and guards an unresolved __proto__ by ownership', () => {
    const node = extractJsonSchema(
      JSON.parse(
        '{"type":"object","properties":{"ref":{"anyOf":[{"type":"string"},{"type":"integer"}]},"__proto__":{}}}',
      ),
    );
    const text = emit(node, 'mixed');
    expect(text).toContain('  ref?: string | number;');
    const build = load(text).buildMixed!;
    expect(() => build()).toThrow(/mixed\.__proto__ is unresolved/);
    const override = JSON.parse('{"__proto__":{"k":1}}') as object;
    expect(Object.hasOwn(build(override), '__proto__')).toBe(true);
  });

  it('an explicit undefined override keeps the required default (#1014)', () => {
    const node = extractJsonSchema({
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } },
    });
    const built = load(emit(node, 'keep')).buildKeep!({ id: undefined });
    expect(typeof built.id).toBe('string');
  });
});

describe('emitVitest', () => {
  it('exports buildOrder, OrderFixture and orderCases', () => {
    expect(text()).toMatch(/export interface OrderFixture \{/);
    expect(text()).toMatch(
      /export function buildOrder\(\s*overrides: Partial<OrderFixture> = \{\},?\s*\): OrderFixture/,
    );
    expect(text()).toMatch(/export const orderCases: ReadonlyArray<\{/);
  });
  it('holds literals only: no PRNG, clock, or runtime generator call', () => {
    expect(text()).not.toMatch(
      /Math\.random|Date\.now|new Date\(|mulberry32|faker/,
    );
  });
  it('builds a fresh object per call (no shared module-level default)', () => {
    expect(text()).toMatch(
      /export function buildOrder[\s\S]*const base[^=]*= \{/,
    );
  });
  it('an unresolved field becomes a throwing overrides-required placeholder', () => {
    expect(text()).toContain('  meta: unknown;');
    expect(text()).toContain(
      "throw new Error('gen-data: order.meta is unresolved (no type declared); pass it via overrides');",
    );
  });
  it('header names seed and source, with no timestamp', () => {
    expect(text().split('\n')[0]).toBe(
      '// Generated by canary gen-data (seed 765) from fixtures/order.schema.json. Regenerate; do not edit.',
    );
  });
  it('is byte-identical across runs', () => {
    expect(text()).toBe(text());
  });

  it('the Order default type-checks against interface Order (criterion 3)', () => {
    const order = extractJsonSchema({
      type: 'object',
      required: ['id', 'total', 'lines'],
      properties: {
        id: { type: 'string' },
        total: { type: 'number' },
        coupon: { type: 'string' },
        lines: {
          type: 'array',
          items: {
            type: 'object',
            required: ['sku', 'qty'],
            properties: { sku: { type: 'string' }, qty: { type: 'integer' } },
          },
        },
      },
    });
    const dir = mkdtempSync(join(tmpdir(), 'gen-data-tsc-'));
    try {
      writeFileSync(
        join(dir, 'order.fixtures.ts'),
        emitVitest(
          order,
          generateFixtureSet(order, 'order', 765),
          'order.schema.json',
        ),
      );
      writeFileSync(
        join(dir, 'check.ts'),
        [
          "import { buildOrder } from './order.fixtures.js';",
          'interface OrderLine { sku: string; qty: number }',
          'interface Order { id: string; total: number; lines: OrderLine[]; coupon?: string }',
          'export const o: Order = buildOrder();',
          "export const p: Order = buildOrder({ coupon: 'SYNTH10' });",
        ].join('\n'),
      );
      const program = ts.createProgram([join(dir, 'check.ts')], {
        strict: true,
        exactOptionalPropertyTypes: true,
        noEmit: true,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        target: ts.ScriptTarget.ES2022,
        skipLibCheck: true,
        types: [],
      });
      const diags = ts
        .getPreEmitDiagnostics(program)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
      expect(diags).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
