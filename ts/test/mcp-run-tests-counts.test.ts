/**
 * bug-fleet A1: `runTestsImpl` (MCP `canary__run_tests`) computes `passed` as
 * the number of " passed" substrings in the runner output plus one when the
 * exit code is 0. That is never the real count: pytest's "3 passed in 0.10s"
 * with exit 0 reports `passed: 2`. The plugin spec promises a passed count,
 * and an agent reading the tool result has no other number to go on.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CanaryTestExecutor } from '../src/core/executor.js';
import { runTestsImpl } from '../src/mcp-server.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('runTestsImpl passed count', () => {
  it('reports the number of tests the runner said passed', () => {
    vi.spyOn(CanaryTestExecutor.prototype, 'execute').mockReturnValue([
      0,
      '3 passed in 0.10s',
      '',
    ]);
    const root = mkdtempSync(join(tmpdir(), 'canary-mcp-count-'));
    roots.push(root);
    const result = runTestsImpl(join(root, 'test_a.py'), root);
    expect(result['passed']).toBe(3);
  });
});
