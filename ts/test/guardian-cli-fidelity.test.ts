/**
 * Regression tests for guardian-CLI fidelity fixes surfaced by adversarial
 * review of the Python->TS port (agent/guardian/cli.py oracle):
 *   #1 usage errors exit 2 (typer/click), not commander's default 1
 *   #3 `watch` has no `-s` short form (only `analyze` does)
 *   #5 `analyze` parses YAML specs (Python `yaml.safe_load`), not JSON only
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { invokeGuardian, mkTmp, rmTmp } from './guardian-cli-testkit.js';

let tmp: string;
beforeEach(() => {
  tmp = mkTmp();
});
afterEach(() => rmTmp(tmp));

describe('usage-error exit code parity (#1: typer/click use 2, not 1)', () => {
  it('unknown option exits 2', async () => {
    const res = await invokeGuardian(['analyze', '--bogus']);
    expect(res.code).toBe(2);
  });

  it('missing required argument exits 2', async () => {
    const res = await invokeGuardian(['validate-coverage']);
    expect(res.code).toBe(2);
  });

  it('unknown command exits 2', async () => {
    const res = await invokeGuardian(['frobnicate']);
    expect(res.code).toBe(2);
  });

  it('explicit --help exits 0 (both typer and commander)', async () => {
    const res = await invokeGuardian(['--help']);
    expect(res.code).toBe(0);
  });
});

describe('flag-surface parity (#3: watch has no -s)', () => {
  it('watch rejects -s as an unknown option (exit 2)', async () => {
    const res = await invokeGuardian([
      'watch',
      '-s',
      'unit',
      '--interval',
      '1',
    ]);
    expect(res.code).toBe(2);
  });

  it('analyze still accepts -s as the suite short form', async () => {
    // `-s api` is valid for analyze; a bare commit + dry-run must not usage-error.
    const res = await invokeGuardian(['analyze', 'abc1234', '-s', 'api']);
    expect(res.code).not.toBe(2);
  });
});

describe('YAML spec parsing (#5: Python yaml.safe_load)', () => {
  it('analyze parses .yaml OpenAPI specs (not JSON-only)', async () => {
    const before = join(tmp, 'before.yaml');
    const after = join(tmp, 'after.yaml');
    writeFileSync(
      before,
      'openapi: "3.0.0"\npaths:\n  /members:\n    get:\n      operationId: list\n',
    );
    writeFileSync(
      after,
      'openapi: "3.0.0"\npaths:\n  /members:\n    get:\n      operationId: list\n  /members/bulk:\n    post:\n      operationId: bulk\n',
    );
    const out = join(tmp, 'api-delta.json');
    const res = await invokeGuardian([
      'analyze',
      'abc1234',
      '--spec-before',
      before,
      '--spec-after',
      after,
      '--suite',
      'api',
      '--emit-diff',
      out,
      '--dry-run',
    ]);
    expect(res.code).toBe(0);
    const delta = JSON.parse(readFileSync(out, 'utf-8'));
    // The YAML was parsed: the added endpoint is detected exactly as the JSON
    // fixture case, proving js-yaml load stood in for Python yaml.safe_load.
    expect(delta.summary.added).toBe(1);
  });
});
