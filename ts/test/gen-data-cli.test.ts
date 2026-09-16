import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

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
