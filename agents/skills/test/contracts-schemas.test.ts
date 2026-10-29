/**
 * The shipped contract schemas (#1151): one per layer, every keyword
 * enforced, every valid fixture accepted, and a planted defect refused so
 * the acceptance tests cannot pass vacuously.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import { checkValue } from '../lib/contracts/schema-check.mjs';
import { schemaProblems } from '../lib/contracts/schema-problems.mjs';
import { validateDocument } from '../lib/contracts/document.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS = path.join(HERE, '..', 'lib', 'contracts');
const FIXTURES = path.join(HERE, 'fixtures', 'contracts');
const LAYERS = ['run', 'assessment', 'site'];
/** Non-layer input files (#1242): critical-areas.json, validated by critical-areas.mjs. */
const INPUT_SCHEMAS = ['critical-areas.v1.schema.json'];
/**
 * Standalone contracts (ADR 0045): a document with a `contract` const that is
 * not a canary.* layer, so each has its own entry point (tool-review.mjs).
 * Named `canary.<name>/<major>`; `<name>` may contain hyphens.
 */
const STANDALONE_CONTRACTS = ['tool-review'];

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
  it('ships one schema per layer plus the declared input and standalone schemas, and nothing else (a zero denominator is not a pass)', () => {
    // Plus the input files canary skills read that are not canary.* layers
    // (no `contract` field to dispatch on), and the standalone contracts
    // (a `contract` const, but no layer), each with its own entry point.
    expect(Object.keys(REGISTRY).sort()).toEqual(
      [
        ...LAYERS.map((l) => `${l}.v1.schema.json`),
        ...INPUT_SCHEMAS,
        ...STANDALONE_CONTRACTS.map((c) => `${c}.v1.schema.json`),
      ].sort(),
    );
  });

  it.each(STANDALONE_CONTRACTS)(
    '%s: $id is its file name, contract its const (canary.<name>/1)',
    (name) => {
      const schema = REGISTRY[`${name}.v1.schema.json`];
      expect(schema.$id).toBe(`${name}.v1.schema.json`);
      expect(schema.properties.contract.const).toBe(`canary.${name}/1`);
    },
  );

  it.each(STANDALONE_CONTRACTS)(
    '%s: validateDocument points its contract const to its own entry point (ADR 0045)',
    (name) => {
      // Ties document.mjs's STANDALONE map to these schemas: a new standalone
      // contract or major (canary.tool-review/2) fails here until it has an
      // entry, instead of getting "not a canary contract string".
      const contract = REGISTRY[`${name}.v1.schema.json`].properties.contract
        .const as string;
      const { errors } = validateDocument({ contract });
      expect(errors).toHaveLength(1);
      expect(errors[0].path).toBe('contract');
      const { message } = errors[0];
      expect(
        message.startsWith(`"${contract}" is a standalone contract:`),
      ).toBe(true);
      expect(
        message.endsWith(`from ${name}.mjs, not validate.mjs (ADR 0045)`),
      ).toBe(true);
    },
  );

  it.each(STANDALONE_CONTRACTS)(
    '%s: the valid fixture has zero schema errors',
    (name) => {
      expect(errorsFor(name, fixture(name))).toEqual([]);
    },
  );

  it('tool-review: reviewed_at uses the run timestamp pattern verbatim', () => {
    // A hand copy, not a cross-file $ref, so tool-review.mjs loads one file.
    const own = REGISTRY['tool-review.v1.schema.json'].$defs.timestamp;
    const run = REGISTRY['run.v1.schema.json'].$defs.timestamp;
    expect(own.type).toBe(run.type);
    expect(own.pattern).toBe(run.pattern);
  });

  it.each(INPUT_SCHEMAS)(
    '%s: $id is its file name, no contract const',
    (id) => {
      expect(REGISTRY[id].$id).toBe(id);
      expect(REGISTRY[id].properties.contract).toBeUndefined();
    },
  );

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

  it('assessment: scope and text defs are identical to run (one D2 scope)', () => {
    const run = REGISTRY['run.v1.schema.json'].$defs;
    const assessment = REGISTRY['assessment.v1.schema.json'].$defs;
    expect(assessment.scope).toEqual(run.scope);
    expect(assessment.text).toEqual(run.text);
    expect(assessment.timestamp).toEqual(run.timestamp);
  });

  it('assessment: verified_at uses the run timestamp pattern verbatim', () => {
    // Not a $ref: verified_at is nullable and $defs/timestamp is type
    // "string", so a ref would refuse null. This pins the hand copy instead.
    const verifiedAt =
      REGISTRY['assessment.v1.schema.json'].properties.verified_at;
    expect(verifiedAt.type).toEqual(['string', 'null']);
    expect(verifiedAt.pattern).toBe(
      REGISTRY['run.v1.schema.json'].$defs.timestamp.pattern,
    );
  });

  it('assessment: refuses a value of type string (fork D: no "N/A")', () => {
    const doc = fixture('assessment');
    doc.value = 'N/A';
    expect(errorsFor('assessment', doc).map((e) => e.path)).toEqual(['value']);
  });

  it('assessment: refuses an unknown status (planted)', () => {
    const doc = fixture('assessment');
    doc.status = 'green';
    expect(errorsFor('assessment', doc).map((e) => e.path)).toEqual(['status']);
  });

  it('site: refuses a bare-string scope on suites[] (fork B, D2)', () => {
    const doc = fixture('site');
    doc.suites[0].scope = 'canary';
    expect(errorsFor('site', doc)).toEqual([
      { path: 'suites[0].scope', message: 'expected object, got string' },
    ]);
  });

  it('site: validates nested runs against canary.run/1 (cross-file $ref)', () => {
    const doc = fixture('site');
    delete doc.runs[1].scope.env;
    expect(errorsFor('site', doc).map((e) => e.path)).toEqual([
      'runs[1].scope.env',
    ]);
  });

  it('site: refuses a register row without its commit (fork C, amended)', () => {
    const doc = fixture('site');
    delete doc.register[0].commit;
    expect(errorsFor('site', doc).map((e) => e.path)).toEqual([
      'register[0].commit',
    ]);
  });

  it('site: suites may be null (no declaration, D12) but not absent', () => {
    const declaredNone = fixture('site');
    declaredNone.suites = null;
    expect(errorsFor('site', declaredNone)).toEqual([]);
    const absent = fixture('site');
    delete absent.suites;
    expect(errorsFor('site', absent).map((e) => e.path)).toEqual(['suites']);
  });
});
