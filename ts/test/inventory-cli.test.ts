/**
 * `canary inventory` (#957): writes `.canary/test-inventory.json`, and refuses
 * to write an empty one. An empty inventory would let every downstream check
 * read "0 of 0" as clean, so zero tests is exit 3 (abstained) with no file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXIT_ABSTAINED } from '../src/core/gate-result.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

const OUT = join('.canary', 'test-inventory.json');

describe('canary inventory', () => {
  let root: string;
  beforeEach(() => {
    root = mkTmp();
  });
  afterEach(() => {
    rmTmp(root);
  });

  it('writes a v1 inventory under --root and exits 0', async () => {
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(
      join(root, 'tests', 'a.test.ts'),
      "import { a } from '../src/a.js';\nit('a', () => {\n  expect(a()).toBe(1);\n});\n",
      'utf-8',
    );
    const res = await invokeCanary(['inventory', '--root', root]);
    expect(res.code).toBe(0);
    const written = JSON.parse(readFileSync(join(root, OUT), 'utf-8'));
    expect(written.schema_version).toBe(1);
    expect(written.files[0].path).toBe('tests/a.test.ts');
    expect(written.files[0].tests).toEqual([{ name: 'a', line: 2, depth: 2 }]);
    expect(res.stdout).toMatch(/1 test\(s\) in 1 file\(s\)/);
  });

  it('abstains with exit 3 and writes nothing when no tests are found', async () => {
    const res = await invokeCanary(['inventory', '--root', root]);
    expect(res.code).toBe(EXIT_ABSTAINED);
    expect(existsSync(join(root, OUT))).toBe(false);
    expect(res.stdout + res.stderr).toMatch(/0 tests/);
  });
});
