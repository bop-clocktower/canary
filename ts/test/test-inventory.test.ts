/**
 * `buildInventory` / `assertionDepth` (#957): the producer behind
 * `.canary/test-inventory.json`. Depth is a static tier, so these tests pin the
 * tier boundaries rather than any runtime notion of coverage.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  INVENTORY_SCHEMA_VERSION,
  assertionDepth,
  buildInventory,
} from '../src/core/test-inventory.js';
import { collectTestFiles } from '../src/core/test-files.js';
import { mkTmp, rmTmp } from './canary-cli-testkit.js';

function put(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body, 'utf-8');
}

describe('assertionDepth', () => {
  it('is 0 when a JS test body holds no recognised assertion', () => {
    expect(assertionDepth('\n  doThing();\n', false)).toBe(0);
  });

  it('is 1 when every JS assertion is an absence or trivial presence', () => {
    const body = '\n  expect(x).toBeDefined();\n  expect(y).toBeNull();\n';
    expect(assertionDepth(body, false)).toBe(1);
  });

  it('is 2 when any JS assertion is shaped', () => {
    const body = '\n  expect(x).toBeDefined();\n  expect(total(2)).toBe(4);\n';
    expect(assertionDepth(body, false)).toBe(2);
  });

  it('tiers Python the same way', () => {
    expect(assertionDepth('\n    run()\n', true)).toBe(0);
    expect(assertionDepth('\n    assert result is None\n', true)).toBe(1);
    expect(assertionDepth('\n    assert add(1, 2) == 3\n', true)).toBe(2);
  });
});

describe('buildInventory', () => {
  let root: string;
  beforeEach(() => {
    root = mkTmp();
  });
  afterEach(() => {
    rmTmp(root);
  });

  it('lists each test with its depth and resolves relative imports to root-relative targets', () => {
    put(
      root,
      'tests/cart.test.ts',
      [
        "import { add } from '../src/cart.js';",
        "import { it, expect } from 'vitest';",
        "it('adds', () => {",
        '  expect(add(1)).toBe(1);',
        '});',
        "it('exists', () => {",
        '  expect(add).toBeDefined();',
        '});',
      ].join('\n'),
    );
    const inv = buildInventory(
      root,
      collectTestFiles(root),
      '2026-09-15T00:00:00.000Z',
    );
    expect(inv.schema_version).toBe(INVENTORY_SCHEMA_VERSION);
    expect(inv.files).toEqual([
      {
        path: 'tests/cart.test.ts',
        framework: 'vitest',
        targets: ['src/cart'],
        tests: [
          { name: 'adds', line: 3, depth: 2 },
          { name: 'exists', line: 6, depth: 1 },
        ],
      },
    ]);
  });

  it('maps Python dotted and relative from-imports to paths', () => {
    put(
      root,
      'pkg/tests/test_pay.py',
      [
        'from pkg.billing import charge',
        'from .helpers import mk',
        '',
        'def test_charge():',
        '    assert charge(1) == 1',
      ].join('\n'),
    );
    const inv = buildInventory(root, collectTestFiles(root), 'now');
    expect(inv.files[0]!.framework).toBe('pytest');
    expect(inv.files[0]!.targets).toEqual(['pkg/billing', 'pkg/tests/helpers']);
    expect(inv.files[0]!.tests).toEqual([
      { name: 'test_charge', line: 4, depth: 2 },
    ]);
  });

  it('returns no files when the tree holds no tests', () => {
    put(root, 'src/a.ts', 'export const a = 1;\n');
    const inv = buildInventory(root, collectTestFiles(root), 'now');
    expect(inv.files).toEqual([]);
  });
});
