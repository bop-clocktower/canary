import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DomainScanner, isEmpty } from '../src/core/domain-scanner.js';
import { makeProject, type TempProject } from './scanner-testkit.js';

let project: TempProject | null = null;
afterEach(() => {
  project?.cleanup();
  project = null;
});

function scan(files: Record<string, string>) {
  project = makeProject(files);
  return new DomainScanner().scan(project.root);
}

describe('DomainScanner', () => {
  it('returns an empty context when there are no source files', () => {
    const ctx = scan({ 'README.md': 'hi', 'data.json': '{}' });
    expect(isEmpty(ctx)).toBe(true);
    expect(ctx.sourceFiles).toBe(0);
  });

  it('extracts Python classes, public functions, and routes', () => {
    const ctx = scan({
      'svc.py': [
        'class Widget:',
        '    pass',
        'def make_widget():',
        '    return 1',
        'def _private():',
        '    return 2',
        "@app.get('/a')",
        'def get_a():',
        '    pass',
        "@app.route('/health')",
        'def health():',
        '    pass',
      ].join('\n'),
    });
    expect(ctx.components).toContain('Widget');
    expect(ctx.functions).toContain('make_widget');
    expect(ctx.functions).not.toContain('_private');
    expect(ctx.apiRoutes).toContain('GET /a');
    expect(ctx.apiRoutes).toContain('/health'); // @app.route → bare path
  });

  it('classifies JS exports (PascalCase → component, camelCase → function)', () => {
    const ctx = scan({
      'ui.ts': [
        'export default class App {}',
        'export function doThing() {}',
        'export function Widget() {}',
        'export const Card = () => 1;',
        'export const helper = () => 2;',
        "router.get('/x', () => {});",
      ].join('\n'),
    });
    expect(ctx.components).toEqual(
      expect.arrayContaining(['App', 'Widget', 'Card']),
    );
    expect(ctx.functions).toEqual(
      expect.arrayContaining(['doThing', 'helper']),
    );
    expect(ctx.apiRoutes).toContain('GET /x');
  });

  it('skips test files, ignored dirs, and strips __init__ from modules', () => {
    const ctx = scan({
      'pkg/__init__.py': 'class Root:\n    pass',
      'pkg/mod.py': 'def f():\n    pass',
      'foo.test.ts': 'export class ShouldSkip {}',
      'node_modules/dep/index.js': 'export function nope() {}',
    });
    expect(ctx.modules).toContain('pkg'); // __init__ stripped to package dir
    expect(ctx.modules).toContain('pkg/mod');
    expect(ctx.components).not.toContain('ShouldSkip');
    expect(ctx.components).not.toContain('nope');
  });

  it('skips files larger than the byte cap', () => {
    const big = 'x'.repeat(40_000);
    const ctx = scan({ 'big.ts': `export class Big {}\n// ${big}` });
    expect(ctx.sourceFiles).toBe(0);
  });

  it('caps each category at 15 items', () => {
    const classes = Array.from(
      { length: 20 },
      (_, i) => `class C${i}:\n    pass`,
    ).join('\n');
    const ctx = scan({ 'many.py': classes });
    expect(ctx.components).toHaveLength(15);
  });

  it('rejects files whose absolute path has an ignored ancestor segment', () => {
    // Root nested under a "tests" dir → DomainScanner must find nothing,
    // matching Python's absolute-path-parts check.
    const base = mkdtempSync(join(tmpdir(), 'canary-anc-'));
    const root = join(base, 'tests', 'proj');
    const file = join(root, 'src', 'app.ts');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'export class Buried {}', 'utf-8');
    try {
      const ctx = new DomainScanner().scan(root);
      expect(ctx.sourceFiles).toBe(0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
