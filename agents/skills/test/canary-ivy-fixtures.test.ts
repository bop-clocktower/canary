/**
 * canary-ivy (#615) -- duplicated fixtures (spec D5, SC6). Fixture suites are
 * synthetic, written into a temp directory per test.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  extractBlocks,
  scanFixtures,
  walkTestFiles,
} from '../claude-code/canary-ivy/scripts/fixtures.mjs';

const tmps: string[] = [];
function tmp(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-ivy-fx-'));
  tmps.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

afterEach(() => {
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
});

const PY_FIXTURE = [
  'import pytest',
  '',
  '@pytest.fixture(scope="module")',
  'def db():',
  '    conn = make_db()',
  '    # seed the rows',
  '    conn.seed(rows=3)',
  '    yield conn',
  '',
  'def test_x(db):',
  '    assert db',
].join('\n');

const JS_HOOK = [
  "import { beforeEach, it } from 'vitest';",
  'beforeEach(() => {',
  '  store = createStore();',
  '  // reset the clock',
  '  store.load(seed);',
  '});',
  "it('works', () => {});",
].join('\n');

describe('extractBlocks', () => {
  it('reads a pytest fixture body, dropping comments and blank lines', () => {
    const blocks = extractBlocks(PY_FIXTURE, 'conftest.py');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: 'pytest-fixture',
      name: 'db',
      line: 4,
      body: ['conn = make_db()', 'conn.seed(rows=3)', 'yield conn'],
    });
  });

  it('reads unittest setUp and setup_method', () => {
    const text = [
      'class T:',
      '    def setUp(self):',
      '        self.a = 1',
      '        self.b = 2',
      '    def setup_method(self):',
      '        self.c = 3',
      '        self.d = 4',
    ].join('\n');
    const blocks = extractBlocks(text, 'test_t.py');
    expect(blocks.map((b: { name: string }) => b.name)).toEqual([
      'setUp',
      'setup_method',
    ]);
    expect(blocks[0].kind).toBe('setup');
  });

  it('reads a JS beforeEach body between its braces', () => {
    const blocks = extractBlocks(JS_HOOK, 'a.test.ts');
    expect(blocks).toEqual([
      {
        kind: 'beforeEach',
        name: 'beforeEach',
        line: 2,
        body: ['store = createStore();', 'store.load(seed);'],
      },
    ]);
  });

  it('reads a PHP setUp only in .php files', () => {
    const text = [
      'class FooTest extends TestCase {',
      '  protected function setUp(): void {',
      '    $this->a = new A();',
      '    $this->b = new B();',
      '  }',
      '}',
    ].join('\n');
    expect(extractBlocks(text, 'FooTest.php')[0]).toMatchObject({
      kind: 'php-setUp',
      line: 2,
    });
    expect(extractBlocks(text, 'foo.test.js')).toEqual([]);
  });

  it('ignores one-line hooks, unclosed blocks and a fixture with no def', () => {
    expect(
      extractBlocks('beforeEach(() => vi.restoreAllMocks());', 'a.test.js'),
    ).toEqual([]);
    expect(
      extractBlocks('beforeAll(() => {\n  a();\n  b();', 'a.test.js'),
    ).toEqual([]);
    expect(extractBlocks('@pytest.fixture\nx = 1\n', 'conftest.py')).toEqual(
      [],
    );
    expect(extractBlocks('def setUp(self):\n    a = 1\n', 'test_a.py')).toEqual(
      [],
    );
  });

  it('ignores files of unsupported types', () => {
    expect(extractBlocks(JS_HOOK, 'notes.txt')).toEqual([]);
  });
});

describe('walkTestFiles', () => {
  it('visits test files and conftest.py, skipping dependency directories', () => {
    const dir = tmp({
      'tests/conftest.py': '',
      'tests/test_a.py': '',
      'tests/helper.py': '',
      'src/a.spec.ts': '',
      'src/a.ts': '',
      'node_modules/x/b.test.js': '',
      'php/FooTest.php': '',
    });
    const rel = walkTestFiles([dir]).map((f: string) =>
      path.relative(dir, f).split(path.sep).join('/'),
    );
    expect(rel).toEqual([
      'php/FooTest.php',
      'src/a.spec.ts',
      'tests/conftest.py',
      'tests/test_a.py',
    ]);
  });

  it('always includes a file named explicitly', () => {
    const dir = tmp({ 'helper.py': '' });
    expect(walkTestFiles([path.join(dir, 'helper.py')])).toHaveLength(1);
  });

  it('throws on a path that does not exist', () => {
    expect(() => walkTestFiles(['/no/such/ivy/path'])).toThrow(
      'path not found: /no/such/ivy/path',
    );
  });
});

describe('scanFixtures', () => {
  it('groups the same body across files, with every location', () => {
    const dir = tmp({
      'a/conftest.py': PY_FIXTURE,
      'b/conftest.py': PY_FIXTURE.replace('def db', 'def database'),
      'c/a.test.ts': JS_HOOK,
    });
    const result = scanFixtures([dir], dir);
    expect(result.filesScanned).toBe(3);
    expect(result.setupBlocks).toBe(3);
    expect(result.groups).toEqual([
      {
        kind: 'pytest-fixture',
        body_lines: 3,
        first_line: 'conn = make_db()',
        locations: [
          { file: 'a/conftest.py', line: 4, name: 'db' },
          { file: 'b/conftest.py', line: 4, name: 'database' },
        ],
      },
    ]);
  });

  it('does not group bodies that differ by one line', () => {
    const dir = tmp({
      'a.test.ts': JS_HOOK,
      'b.test.ts': JS_HOOK.replace('store.load(seed)', 'store.load(other)'),
    });
    expect(scanFixtures([dir], dir).groups).toEqual([]);
  });

  it('orders groups by location count, then by first location', () => {
    const dir = tmp({
      'x1.test.ts': JS_HOOK,
      'x2.test.ts': JS_HOOK,
      'x3.test.ts': JS_HOOK,
      'a/conftest.py': PY_FIXTURE,
      'b/conftest.py': PY_FIXTURE,
    });
    const groups = scanFixtures([dir], dir).groups;
    expect(
      groups.map((g: { locations: unknown[] }) => g.locations.length),
    ).toEqual([3, 2]);
  });
});
