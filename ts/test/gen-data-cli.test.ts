import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_ABSTAINED } from '../src/core/gate-result.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

describe('canary gen-data outcomes', () => {
  let root: string;
  beforeEach(() => {
    root = mkTmp();
  });
  afterEach(() => rmTmp(root));
  const write = (name: string, s: unknown) => {
    const p = join(root, name);
    writeFileSync(p, JSON.stringify(s));
    return p;
  };
  const out = () => join(root, 'out');

  it('abstains with exit 3, writes nothing, and names every unresolved path (criteria 4, 6)', async () => {
    const p = write('blob.schema.json', {
      type: 'object',
      properties: { a: {}, b: { $ref: '#/x' } },
    });
    const res = await invokeCanary([
      'gen-data',
      '--schema',
      p,
      '--framework',
      'vitest',
      '--out',
      out(),
    ]);
    expect(res.code).toBe(EXIT_ABSTAINED);
    expect(existsSync(out())).toBe(false);
    expect(res.stdout).toMatch(/blob\.a: no type declared/);
    expect(res.stdout).toMatch(/blob\.b: \$ref is not resolved in this slice/);
  });

  it('partial resolution exits 0 and discloses N/M in human output (criterion 5)', async () => {
    const p = write('order.schema.json', {
      title: 'Order',
      type: 'object',
      properties: { id: { type: 'string' }, meta: {} },
    });
    const res = await invokeCanary([
      'gen-data',
      '--schema',
      p,
      '--framework',
      'vitest',
      '--out',
      out(),
    ]);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/1\/2 fields resolved/);
    expect(res.stdout).toMatch(/order\.meta: no type declared/);
    expect(readFileSync(join(out(), 'order.fixtures.ts'), 'utf-8')).toMatch(
      /export function buildOrder/,
    );
  });

  it('--json carries the spec report shape (criterion 5)', async () => {
    const p = write('order.schema.json', {
      title: 'Order',
      type: 'object',
      properties: { id: { type: 'string' }, meta: {} },
    });
    const res = await invokeCanary([
      'gen-data',
      '--schema',
      p,
      '--framework',
      'vitest',
      '--out',
      out(),
      '--json',
      '--seed',
      '7',
    ]);
    const report = JSON.parse(res.stdout);
    expect(report).toMatchObject({
      seed: 7,
      fieldsTotal: 2,
      fieldsResolved: 1,
      unresolved: [{ path: 'order.meta', reason: 'no type declared' }],
      categoriesCovered: expect.arrayContaining(['boundary']),
      notCovered: expect.arrayContaining([
        { category: 'race', reason: 'not data-expressible' },
      ]),
      selfCheck: { status: 'ran', findings: 0 },
    });
    expect(report.casesEmitted).toBeGreaterThan(0);
    expect(report.output).toBe(join(out(), 'order.fixtures.ts'));
  });

  it('self-check findings exit 1 and write nothing', async () => {
    const p = write('order.schema.json', {
      title: 'Order',
      type: 'object',
      properties: { id: { type: 'string' } },
    });
    const res = await invokeCanary(
      ['gen-data', '--schema', p, '--framework', 'vitest', '--out', out()],
      {
        deps: {
          genDataSelfCheck: async () => ({
            status: 'ran',
            detectors: ['canary-blackhawk'],
            findings: [
              {
                detector: 'canary-blackhawk',
                ruleId: 'BH001',
                line: 3,
                snippet: 'Date.now()',
              },
            ],
          }),
        },
      },
    );
    expect(res.code).toBe(1);
    expect(existsSync(out())).toBe(false);
    expect(res.stdout).toMatch(/BH001/);
  });

  it('self-check unavailable abstains (exit 3) and writes nothing (C1)', async () => {
    const p = write('order.schema.json', {
      title: 'Order',
      type: 'object',
      properties: { id: { type: 'string' } },
    });
    const res = await invokeCanary(
      ['gen-data', '--schema', p, '--framework', 'vitest', '--out', out()],
      {
        deps: {
          genDataSelfCheck: async () => ({
            status: 'unavailable',
            reason: 'canary-savant scanner not found',
          }),
        },
      },
    );
    expect(res.code).toBe(3);
    expect(existsSync(out())).toBe(false);
  });
});

const ORDER = {
  title: 'Order',
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string' }, total: { type: 'number' } },
};

describe('canary gen-data usage errors (exit 2)', () => {
  let root: string;
  let schema: string;
  beforeEach(() => {
    root = mkTmp();
    schema = join(root, 'order.schema.json');
    writeFileSync(schema, JSON.stringify(ORDER));
  });
  afterEach(() => rmTmp(root));

  const run = (...extra: string[]) =>
    invokeCanary([
      'gen-data',
      '--schema',
      schema,
      '--out',
      join(root, 'out'),
      ...extra,
    ]);

  it.each([
    [
      ['--framework', 'vitest', '--seed', '1.5'],
      /--seed must be a safe integer/,
    ],
    [['--framework', 'jest'], /unknown framework "jest"/],
    [['--framework', 'pytest'], /pytest is not yet supported in this slice/],
  ])('%j exits 2', async (args, msg) => {
    const res = await run(...args);
    expect(res.code).toBe(2);
    expect(res.stdout + res.stderr).toMatch(msg);
    expect(existsSync(join(root, 'out'))).toBe(false);
  });

  it('a missing schema file exits 2', async () => {
    const res = await invokeCanary([
      'gen-data',
      '--schema',
      join(root, 'nope.json'),
      '--framework',
      'vitest',
    ]);
    expect(res.code).toBe(2);
    expect(res.stdout + res.stderr).toMatch(/cannot read schema/);
  });

  it('unparseable JSON exits 2', async () => {
    writeFileSync(schema, '{ not json');
    expect((await run('--framework', 'vitest')).code).toBe(2);
  });

  it('a non-object root exits 2', async () => {
    writeFileSync(schema, JSON.stringify({ type: 'string' }));
    const res = await run('--framework', 'vitest');
    expect(res.code).toBe(2);
    expect(res.stdout + res.stderr).toMatch(
      /schema root must be type "object"/,
    );
  });
});

describe('canary gen-data determinism', () => {
  let root: string;
  beforeEach(() => {
    root = mkTmp();
  });
  afterEach(() => rmTmp(root));
  const gen = async (seed: string, outDir: string) => {
    const p = join(root, 'order.schema.json');
    writeFileSync(
      p,
      JSON.stringify({
        title: 'Order',
        type: 'object',
        properties: { id: { type: 'string' }, total: { type: 'number' } },
      }),
    );
    const res = await invokeCanary(
      [
        'gen-data',
        '--schema',
        p,
        '--framework',
        'vitest',
        '--seed',
        seed,
        '--out',
        join(root, outDir),
      ],
      { cwd: root },
    );
    expect(res.code).toBe(0);
    return readFileSync(join(root, outDir, 'order.fixtures.ts'), 'utf-8');
  };

  it('same seed twice -> byte-identical files (criterion 1)', async () => {
    expect(await gen('765', 'a')).toBe(await gen('765', 'b'));
  });
  it('different seed -> a non-boundary literal changes (criterion 2)', async () => {
    const a = await gen('765', 'a');
    const b = await gen('766', 'b');
    expect(a).not.toBe(b);
    const defaultBlock = (t: string) =>
      t.slice(t.indexOf('const base'), t.indexOf('return {'));
    expect(defaultBlock(a)).not.toBe(defaultBlock(b));
  });
});
