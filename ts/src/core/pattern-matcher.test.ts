import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PatternMatcher, isEmpty } from './pattern-matcher.js';

const pm = new PatternMatcher();
const dirs: string[] = [];

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'pm-'));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf-8');
  }
  return root;
}

afterEach(() => {
  // temp dirs are OS-cleaned; nothing to assert here.
});

describe('PatternMatcher edge branches', () => {
  it('returns an empty profile when no test files match', () => {
    const root = project({ 'src/app.ts': 'export const x = 1;\n' });
    const profile = pm.scan(root, 'pytest');
    expect(isEmpty(profile)).toBe(true);
    expect(profile.test_count).toBe(0);
  });

  it('never descends into ignored dirs (node_modules)', () => {
    const root = project({
      'node_modules/pkg/thing.test.ts': 'it("x", () => {});\n',
      'tests/real.test.ts':
        'describe("r", () => { it("works", () => {}); });\n',
    });
    const profile = pm.scan(root, 'vitest');
    expect(profile.test_count).toBe(1);
  });

  it('detects chai assertion style from imports', () => {
    const root = project({
      'a.test.ts': `import { expect } from 'chai';\ndescribe('s', () => { it('Should do a thing', () => {}); });\n`,
    });
    const profile = pm.scan(root, 'vitest');
    expect(profile.assertion_style).toBe('chai expect assertions');
    expect(profile.uses_describe).toBe(true);
  });

  it('detects assert-style imports and imperative names', () => {
    const root = project({
      'a.test.ts': `import assert from 'node:assert';\ntest('adds numbers', () => {});\n`,
    });
    const profile = pm.scan(root, 'vitest');
    expect(profile.assertion_style).toBe('assert-style assertions');
  });

  it('classifies python class-based unittest style', () => {
    const root = project({
      'test_thing.py': `import unittest\n\nclass TestThing(unittest.TestCase):\n    def test_when_ready_it_runs(self):\n        self.assertTrue(True)\n`,
    });
    const profile = pm.scan(root, 'pytest');
    expect(profile.language).toBe('python');
    expect(profile.uses_classes).toBe(true);
    expect(profile.assertion_style).toBe('unittest self.assert* methods');
  });

  it('infers python by extension when framework is ambiguous', () => {
    const root = project({ 'test_x.py': 'def test_a():\n    assert True\n' });
    const profile = pm.scan(root); // no framework/test_type
    expect(profile.language).toBe('python');
  });
});
