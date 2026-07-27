/**
 * Tests for the `scaffolder` port (`agent/core/scaffolder.py`,
 * `tests/unit/test_scaffolder.py`). Every Python case is preserved. The emitted
 * config bodies are also checked byte-for-byte against the Python oracle by the
 * repo's cross-runtime diff harness; here we assert the summary shape and the
 * loud-degrade contract.
 */

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Scaffolder, scaffoldableFrameworks } from '../src/core/scaffolder.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'canary-scaffold-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('Scaffolder.scaffold', () => {
  const s = new Scaffolder();

  it('scaffolds playwright', () => {
    const result = s.scaffold('playwright', root);
    expect(result['framework']).toBe('playwright');
    expect(result['created_files']).toContain('playwright.config.ts');
    expect(result['created_dirs']).toContain('tests/e2e');
    expect(existsSync(join(root, 'playwright.config.ts'))).toBe(true);
    expect(statSync(join(root, 'tests/e2e')).isDirectory()).toBe(true);
  });

  it('scaffolds pytest', () => {
    const result = s.scaffold('pytest', root);
    expect(result['framework']).toBe('pytest');
    expect(result['created_files']).toContain('pytest.ini');
    expect(result['created_dirs']).toContain('tests');
    expect(existsSync(join(root, 'pytest.ini'))).toBe(true);
    expect(statSync(join(root, 'tests')).isDirectory()).toBe(true);
  });

  it('scaffolds wdio', () => {
    const result = s.scaffold('wdio', root);
    expect(result['framework']).toBe('wdio');
    expect(result['created_files']).toContain('wdio.conf.ts');
    expect(result['created_dirs']).toContain('tests');
    expect(existsSync(join(root, 'wdio.conf.ts'))).toBe(true);
    expect(statSync(join(root, 'tests')).isDirectory()).toBe(true);
  });

  it('lowercases the framework name', () => {
    // capabilities()/scaffold() agree on case-insensitivity.
    const result = s.scaffold('Playwright', root);
    expect(result['framework']).toBe('playwright');
    expect(result['status']).toBe('scaffolded');
  });

  it('skips files that already exist on a second run', () => {
    s.scaffold('pytest', root);
    const second = s.scaffold('pytest', root);
    expect(second['created_files']).toEqual([]);
    // The dir already exists too, so nothing new is created.
    expect(second['created_dirs']).toEqual([]);
    expect(second['skipped_files']).toEqual(['pytest.ini']);
  });

  it('raises for a framework not even in the registry', () => {
    // Genuinely invalid input still throws (Python `ValueError`).
    expect(() => s.scaffold('nonexistent', root)).toThrow(
      /Unknown framework: 'nonexistent'/,
    );
  });

  it('degrades loudly for a known framework without a template', () => {
    // schemathesis is a real registry framework with no scaffold template.
    const result = s.scaffold('schemathesis', root);
    expect(result['status']).toBe('unsupported');
    expect(result['framework']).toBe('schemathesis');
    expect(result['created_files']).toEqual([]);
    expect(result['created_dirs']).toEqual([]);
    expect(result['guidance']).toBeTruthy();
    expect(result['execution_command']).toContain('schemathesis');
  });

  it('degrade for a framework with no run command notes so', () => {
    // tosca has neither template nor a runnable command.
    const result = s.scaffold('tosca', root);
    expect(result['status']).toBe('unsupported');
    expect(result['execution_command']).toBeNull();
    expect(result['guidance']).toContain('does not yet have a run command');
  });

  it('degrade never writes files', () => {
    const before = new Set(readdirSync(root));
    s.scaffold('locust', root);
    const after = new Set(readdirSync(root));
    expect(after).toEqual(before);
  });
});

describe('scaffoldableFrameworks', () => {
  it('is the set of template names', () => {
    expect(scaffoldableFrameworks()).toEqual(
      new Set(['playwright', 'vitest', 'pytest', 'k6', 'wdio']),
    );
  });
});
