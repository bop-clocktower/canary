/**
 * `canary permission-matrix` (#857): writes the suite, and a matrix with holes
 * exits 3 rather than reading as a clean generation.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXIT_ABSTAINED } from '../src/core/gate-result.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

const MODEL = `roles: [staff]
tenants: [a, b]
endpoints:
  GET /persons/{id}:
    staff: own-tenant
`;

async function run(model: string) {
  const home = mkTmp();
  try {
    const m = join(home, 'model.yaml');
    const out = join(home, 'authz.spec.ts');
    writeFileSync(m, model, 'utf-8');
    const res = await invokeCanary(['permission-matrix', m, '--out', out]);
    return {
      ...res,
      spec: existsSync(out) ? readFileSync(out, 'utf-8') : null,
    };
  } finally {
    rmTmp(home);
  }
}

describe('canary permission-matrix', () => {
  it('writes one test per cell and exits 0 when fully declared', async () => {
    const res = await run(MODEL);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/Wrote 4 cell test\(s\).*2 cross-tenant/);
    expect(res.spec).toContain('staff@a -> b: GET /persons/{id} is denied');
  });

  it('still writes the suite but exits 3 when a cell is undeclared', async () => {
    const res = await run(MODEL.replace('staff:', 'other:'));
    expect(res.code).toBe(EXIT_ABSTAINED);
    expect(res.stdout).toMatch(/UNDECLARED/);
    expect(res.stdout).toContain('GET /persons/{id} × staff');
    expect(res.spec).toContain('test.fixme(');
  });
});
