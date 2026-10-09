/**
 * A coverage report path that collides with an Object.prototype key must not
 * leak hit counts into every other object in the process.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveFromReport } from '../src/guardian/coverage.js';

const LINE = 987654;
let dir: string | null = null;

afterEach(() => {
  // Undo any leak so a red run never poisons sibling tests.
  delete (Object.prototype as Record<number, unknown>)[LINE];
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('report keys that collide with Object.prototype', () => {
  it('an lcov SF record named __proto__ leaves Object.prototype untouched', () => {
    dir = mkdtempSync(join(tmpdir(), 'canary-proto-key-'));
    const report = join(dir, 'lcov.info');
    writeFileSync(
      report,
      `SF:__proto__\nDA:${LINE},3\nend_of_record\nSF:src/a.ts\nDA:1,1\nend_of_record\n`,
      'utf-8',
    );
    resolveFromReport([{ path: 'src/a.ts', added_ranges: [[1, 1]] }], report);
    expect(({} as Record<number, unknown>)[LINE]).toBeUndefined();
  });
});
