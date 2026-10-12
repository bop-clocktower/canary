/**
 * coverage-json path keys written on Windows (`src\\x.ts`) must resolve
 * against POSIX diff paths, exactly as the lcov (#1006) and Cobertura readers
 * already normalize theirs. Without it the same Windows-produced coverage
 * verifies through lcov and silently falls through when transcoded to
 * coverage-json.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveFromReport } from '../src/guardian/coverage.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canary-cj-backslash-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('coverage-json Windows path keys', () => {
  it('a backslash-separated key matches the POSIX changed path', () => {
    const report = join(dir, 'coverage.json');
    writeFileSync(
      report,
      JSON.stringify({ files: { 'src\\x.ts': { line_hits: { '1': 2 } } } }),
      'utf-8',
    );
    const results = resolveFromReport(
      [{ path: 'src/x.ts', added_ranges: [[1, 1]] }],
      report,
    );
    expect(results?.map((r) => r.covered)).toEqual([true]);
  });
});
