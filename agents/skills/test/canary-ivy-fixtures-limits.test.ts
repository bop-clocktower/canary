/**
 * canary-ivy (#615) -- the fixture scan stays bounded on hostile input
 * (security review: resource exhaustion). Every forward scan from a match is
 * capped, and a file over the size limits is reported as not read, never
 * dropped silently. Inputs are generated; nothing is copied from a real suite.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_FILE_BYTES,
  MAX_FILE_LINES,
  extractBlocks,
  scanFixtures,
} from '../claude-code/canary-ivy/scripts/fixtures.mjs';

const tmps: string[] = [];
function tmp(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-ivy-lim-'));
  tmps.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

afterEach(() => {
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
});

const repeat = (line: string, n: number) => Array(n).fill(line);

/**
 * Just under the line limit: a wall of fixture decorators and blank lines,
 * then one def whose indented body runs past the block cap, then a wall of
 * one-line setUp defs. Before the caps, every decorator scanned to the def and
 * every def scanned its whole body: quadratic in the file length (about 2.7 s
 * for this file on a laptop before the fix, against this 1 s budget).
 */
function hostilePython(): string {
  const third = Math.floor((MAX_FILE_LINES - 10) / 3);
  return [
    ...repeat('@pytest.fixture', Math.floor(third / 2)),
    ...repeat('', Math.floor(third / 2)),
    'def wall():',
    ...repeat('    x = 1', third),
    ...repeat('def setUp(self):', third),
  ].join('\n');
}

// The budget is the test timeout: no wall-clock read, so the suite stays
// clean under canary-blackhawk --strict.
const BUDGET_MS = 1000;

describe('bounded fixture scan', () => {
  it(
    'finishes a hostile file under the line limit inside the budget',
    () => {
      const text = hostilePython();
      expect(text.split('\n').length).toBeLessThanOrEqual(MAX_FILE_LINES);
      // The wall body runs past MAX_BLOCK_LINES, so it is abandoned, and no
      // one-line setUp clears the two-line floor.
      expect(extractBlocks(text, 'conftest.py')).toEqual([]);
      const dir = tmp({ 'conftest.py': text });
      const result = scanFixtures([dir], dir);
      expect(result.filesScanned).toBe(1);
      expect(result.unread).toEqual([]);
    },
    BUDGET_MS,
  );

  it(
    'finishes a wall of unclosed JS hooks inside the budget',
    () => {
      // Every line opens a block that never closes, so every match scans
      // MAX_BLOCK_LINES lines. Brace counts are precomputed once per file, so
      // that scan is integer work, not a re-read of each line's characters.
      const line = `beforeEach(() => { const padding = '${'p'.repeat(10)}';`;
      const text = repeat(line, MAX_FILE_LINES - 1).join('\n');
      expect(text.length).toBeLessThan(MAX_FILE_BYTES);
      expect(extractBlocks(text, 'wall.test.ts')).toEqual([]);
    },
    BUDGET_MS,
  );

  it('abandons a decorator whose def is past the decorator run', () => {
    const text = [
      '@pytest.fixture',
      ...repeat('', 25),
      'def late():',
      '    a = 1',
      '    b = 2',
    ].join('\n');
    expect(extractBlocks(text, 'conftest.py')).toEqual([]);
    const near = text.replace('\n'.repeat(25), '\n'.repeat(3));
    expect(extractBlocks(near, 'conftest.py')).toHaveLength(1);
  });

  it(
    'reports a file over the line limit as not read, with the reason',
    () => {
      const big = repeat('@pytest.fixture', MAX_FILE_LINES + 1).join('\n');
      const dir = tmp({ 'conftest.py': big, 'test_ok.py': 'x = 1\n' });
      const result = scanFixtures([dir], dir);
      expect(result.filesScanned).toBe(1);
      expect(result.unread).toEqual([
        {
          file: 'conftest.py',
          reason: `longer than ${MAX_FILE_LINES} lines, not parsed`,
        },
      ]);
    },
    BUDGET_MS,
  );

  it('reports a file over the byte limit as not read without reading it', () => {
    const dir = tmp({ 'test_big.py': 'x'.repeat(MAX_FILE_BYTES + 1) });
    const result = scanFixtures([dir], dir);
    expect(result.filesScanned).toBe(0);
    expect(result.unread).toEqual([
      {
        file: 'test_big.py',
        reason: `larger than ${MAX_FILE_BYTES} bytes, not parsed`,
      },
    ]);
  });
});
