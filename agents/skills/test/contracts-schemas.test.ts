/**
 * The shipped contract schemas (#1151): one per layer, every keyword
 * enforced, every valid fixture accepted, and a planted defect refused so
 * the acceptance tests cannot pass vacuously.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import { checkValue, schemaProblems } from '../lib/contracts/schema-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS = path.join(HERE, '..', 'lib', 'contracts');
const FIXTURES = path.join(HERE, 'fixtures', 'contracts');
// Grows by one layer in Tasks 3 and 4.
const LAYERS = ['run'];

type Doc = Record<string, any>;
const readJson = (p: string): Doc => JSON.parse(fs.readFileSync(p, 'utf8'));

function loadRegistry(): Record<string, Doc> {
  const registry: Record<string, Doc> = {};
  for (const f of fs.readdirSync(CONTRACTS)) {
    if (f.endsWith('.schema.json')) {
      registry[f] = readJson(path.join(CONTRACTS, f));
    }
  }
  return registry;
}

const REGISTRY = loadRegistry();
const fixture = (layer: string) =>
  readJson(path.join(FIXTURES, `${layer}.valid.json`));

function errorsFor(layer: string, doc: unknown) {
  const ctx = {
    registry: REGISTRY,
    base: `${layer}.v1.schema.json`,
    errors: [] as { path: string; message: string }[],
  };
  checkValue(REGISTRY[ctx.base], doc, '$', ctx);
  return ctx.errors;
}

describe('contract schemas', () => {
  it('ships exactly one schema per layer (a zero denominator is not a pass)', () => {
    expect(Object.keys(REGISTRY).sort()).toEqual(
      LAYERS.map((l) => `${l}.v1.schema.json`).sort(),
    );
  });

  it('uses only enforced keywords, and every $ref resolves', () => {
    expect(schemaProblems(REGISTRY)).toEqual([]);
  });

  it.each(LAYERS)('%s: $id is its file name, contract its const', (layer) => {
    const schema = REGISTRY[`${layer}.v1.schema.json`];
    expect(schema.$id).toBe(`${layer}.v1.schema.json`);
    expect(schema.properties.contract.const).toBe(`canary.${layer}/1`);
  });

  it.each(LAYERS)('%s: the valid fixture has zero schema errors', (layer) => {
    expect(errorsFor(layer, fixture(layer))).toEqual([]);
  });

  it('run: refuses the fixture once scope.env is removed (planted)', () => {
    const doc = fixture('run');
    delete doc.scope.env;
    expect(errorsFor('run', doc)).toEqual([
      { path: 'scope.env', message: 'missing required field' },
    ]);
  });

  it('run: refuses an absolute results[].file (ADR 0029 join key)', () => {
    const doc = fixture('run');
    doc.results[0].file = '/home/ci/tests/checkout.spec.ts';
    expect(errorsFor('run', doc).map((e) => e.path)).toEqual([
      'results[0].file',
    ]);
  });
});
