/**
 * LOCAL-ONLY repro (security-routed; do not push). The MCP path-containment
 * guard is applied to write_test_file and run_tests only. init_suite writes a
 * scaffold wherever target_dir points, and analyze_file returns the contents
 * of any readable path, both outside the served root.
 */

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { analyzeFileImpl, initSuiteImpl } from '../src/mcp-server.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function outsideDir(): string {
  // os.tmpdir() is outside process.cwd() (the server root under test).
  const d = mkdtempSync(join(tmpdir(), 'canary-outside-'));
  dirs.push(d);
  return d;
}

describe('MCP tools refuse paths outside the served root', () => {
  it('init_suite does not scaffold into a directory outside the root', () => {
    const outside = outsideDir();
    initSuiteImpl('vitest', outside);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('analyze_file does not return the contents of a file outside the root', () => {
    const outside = outsideDir();
    const secret = join(outside, 'secret.ts');
    writeFileSync(secret, 'export const TOKEN_MARKER = 1;\n', 'utf-8');
    const result = analyzeFileImpl(secret);
    expect(JSON.stringify(result)).not.toContain('TOKEN_MARKER');
    expect(existsSync(secret)).toBe(true);
  });
});
