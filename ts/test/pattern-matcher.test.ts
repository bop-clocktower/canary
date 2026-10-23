/**
 * PatternMatcher import extraction.
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

// #1311: a bare `import` clause that crossed newlines swallowed every import
// line after it, so only the first module of a block was ever counted.
describe('python imports', () => {
  it('counts every module on consecutive import lines', () => {
    write(
      'test_sample.py',
      'import os\nimport sys\nimport json\n\ndef test_a():\n    assert os\n',
    );
    const profile = new PatternMatcher().scan(root, 'pytest');
    expect(profile.common_imports).toEqual(['os', 'sys', 'json']);
  });

  it('counts a from-import that follows a bare import', () => {
    write(
      'test_sample.py',
      'import pytest\nfrom myapp import auth\n\ndef test_a():\n    assert auth\n',
    );
    const profile = new PatternMatcher().scan(root, 'pytest');
    expect(profile.common_imports).toEqual(['pytest', 'myapp']);
  });
});

describe('js imports', () => {
  // A formatter wraps any long specifier list, so a multi-line import is the
  // common shape, not an edge case.
  it('reads an import whose specifier list spans several lines', () => {
    write(
      'sample.test.ts',
      "import {\n  describe,\n  it,\n} from 'vitest';\n\nit('works fine', () => {});\n",
    );
    const profile = new PatternMatcher().scan(root, 'vitest');
    expect(profile.common_imports).toEqual(['vitest']);
  });

  it('does not read past a side-effect import into the next statement', () => {
    write(
      'sample.test.ts',
      "import './setup';\nimport { it } from 'vitest';\n\nit('works fine', () => {});\n",
    );
    const profile = new PatternMatcher().scan(root, 'vitest');
    expect(profile.common_imports).toEqual(['vitest']);
  });
});
