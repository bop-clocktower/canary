/**
 * PatternMatcher import extraction (bug-fleet A6).
 *
 * `common_imports` feeds generated-test conventions, so an import the scan
 * cannot see is a convention the generated test silently drops.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PatternMatcher } from '../src/core/pattern-matcher.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'canary-pattern-matcher-'));
  mkdirSync(join(root, 'tests'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(name: string, content: string): void {
  writeFileSync(join(root, 'tests', name), content, 'utf-8');
}

describe('python imports', () => {
  it('counts every module on consecutive import lines', () => {
    write(
      'test_sample.py',
      'import os\nimport sys\nimport json\n\ndef test_a():\n    assert os\n',
    );
    const profile = new PatternMatcher().scan(root, 'pytest');
    expect(profile.common_imports).toEqual(['os', 'sys', 'json']);
  });
});
