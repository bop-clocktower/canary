/**
 * Unique-importer counts for `canary critical-areas` (#1529). The count is
 * approximate: an ambiguous suffix counts nothing, a bare package never binds a
 * file that shares its name, and a mention in a string can count.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { countImporters } from '../src/critical-areas/importers.js';
import { mkTmp, rmTmp } from './canary-cli-testkit.js';

describe('countImporters', () => {
  let root: string;
  beforeEach(() => {
    root = mkTmp();
  });
  afterEach(() => {
    rmTmp(root);
  });

  function counts(tree: Record<string, string>): ReadonlyMap<string, number> {
    for (const [path, body] of Object.entries(tree)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), body, 'utf-8');
    }
    return countImporters(root, Object.keys(tree)).counts!;
  }

  describe('JS/TS', () => {
    it.each([
      ['import', "import { a } from './a.js';\n"],
      ['export from', "export { a } from './a.js';\n"],
      ['require', "const a = require('./a.js');\n"],
      ['dynamic import', "const a = await import('./a.js');\n"],
      ['side-effect import', "import './a.js';\n"],
    ])('%s counts for src/a.ts', (_name, body) => {
      const c = counts({
        'src/a.ts': 'export const a = 1;\n',
        'src/m.ts': body,
      });
      expect(c.get('src/a.ts')).toBe(1);
    });

    it('resolves an extensionless specifier', () => {
      const c = counts({ 'src/a.ts': '', 'src/m.ts': "import './a';\n" });
      expect(c.get('src/a.ts')).toBe(1);
    });

    it('resolves a directory to its index', () => {
      const c = counts({
        'src/dir/index.ts': '',
        'src/m.ts': "import './dir';\n",
      });
      expect(c.get('src/dir/index.ts')).toBe(1);
    });

    it('counts two imports from one file once', () => {
      const c = counts({
        'src/a.ts': '',
        'src/m.ts': "import './a.js';\nimport { x } from './a.js';\n",
      });
      expect(c.get('src/a.ts')).toBe(1);
    });

    it('counts two importing files twice', () => {
      const c = counts({
        'src/a.ts': '',
        'src/m.ts': "import './a.js';\n",
        'src/n.ts': "import './a.js';\n",
      });
      expect(c.get('src/a.ts')).toBe(2);
    });

    it('does not count a file importing itself', () => {
      const c = counts({ 'src/a.ts': "import './a.js';\n" });
      expect(c.get('src/a.ts')).toBe(0);
    });

    it.each(['@', '~', '#'])('resolves the %s/ alias by unique suffix', (a) => {
      const c = counts({
        'src/lib/a.ts': '',
        'src/m.ts': `import '${a}/lib/a';\n`,
      });
      expect(c.get('src/lib/a.ts')).toBe(1);
    });

    it('counts nothing for an ambiguous alias', () => {
      const c = counts({
        'x/a.ts': '',
        'y/a.ts': '',
        'src/m.ts': "import '@/a';\n",
      });
      expect(c.get('x/a.ts')).toBe(0);
      expect(c.get('y/a.ts')).toBe(0);
    });

    it('keeps a dotted name whole in an alias', () => {
      const c = counts({
        'src/lib/inv.service.ts': '',
        'src/lib/inv.ts': '',
        'src/m.ts': "import '@/lib/inv.service';\n",
      });
      expect(c.get('src/lib/inv.service.ts')).toBe(1);
      expect(c.get('src/lib/inv.ts')).toBe(0);
    });

    it('strips a known code extension from an alias', () => {
      const c = counts({
        'src/lib/a.ts': '',
        'src/m.ts': "import '@/lib/a.ts';\n",
      });
      expect(c.get('src/lib/a.ts')).toBe(1);
    });

    it('does not read a stylesheet alias as the code beside it', () => {
      const c = counts({
        'src/lib/a.ts': '',
        'src/m.ts': "import '@/lib/a.css';\n",
      });
      expect(c.get('src/lib/a.ts')).toBe(0);
    });

    it.each([
      ['//', "// import './a.js';\n"],
      ['indented //', "  // import './a.js';\n"],
      ['/*', "/* import './a.js'; */\n"],
      ['*', "/**\n * import('./a.js')\n */\n"],
    ])('skips a whole-line %s comment', (_name, body) => {
      const c = counts({ 'src/a.ts': '', 'src/m.ts': body });
      expect(c.get('src/a.ts')).toBe(0);
    });

    it('still counts an import after a comment line', () => {
      const c = counts({
        'src/a.ts': '',
        'src/m.ts': "// note\nimport './a.js';\n",
      });
      expect(c.get('src/a.ts')).toBe(1);
    });

    it('still counts a star import', () => {
      const c = counts({
        'src/a.ts': '',
        'src/m.ts': "import * as a from './a.js';\n",
      });
      expect(c.get('src/a.ts')).toBe(1);
    });

    it('counts a mention in a string: the count is approximate', () => {
      const c = counts({
        'src/a.ts': '',
        'src/m.ts': 'const s = "import \'./a.js\'";\n',
      });
      expect(c.get('src/a.ts')).toBe(1);
    });

    it('does not bind a bare package to a file of the same name', () => {
      const c = counts({ 'src/react.ts': '', 'src/m.ts': "import 'react';\n" });
      expect(c.get('src/react.ts')).toBe(0);
    });
  });

  describe('Python', () => {
    it.each([
      ['import a.b', 'import a.b\n'],
      ['from a.b import c', 'from a.b import c\n'],
      ['import x, a.b', 'import x, a.b\n'],
    ])('%s counts for src/a/b.py', (_name, body) => {
      const c = counts({ 'src/a/b.py': '', 'src/m.py': body });
      expect(c.get('src/a/b.py')).toBe(1);
    });

    it('resolves leading dots relative to the file', () => {
      const c = counts({
        'src/a/b.py': '',
        'src/a/m.py': 'from .b import c\n',
        'src/a/n/k.py': 'from ..b import c\n',
      });
      expect(c.get('src/a/b.py')).toBe(2);
    });

    it('resolves a two-dot import through a sibling package', () => {
      const c = counts({
        'pkg/a/b.py': '',
        'pkg/z/m.py': 'from ..a.b import c\n',
      });
      expect(c.get('pkg/a/b.py')).toBe(1);
    });

    it('counts nothing for an ambiguous suffix', () => {
      const c = counts({
        'x/util.py': '',
        'y/util.py': '',
        'src/m.py': 'import util\n',
      });
      expect(c.get('x/util.py')).toBe(0);
      expect(c.get('y/util.py')).toBe(0);
    });
  });

  describe('Python comments and the stdlib', () => {
    it('skips a whole-line # comment', () => {
      const c = counts({ 'src/a/b.py': '', 'src/m.py': '# import a.b\n' });
      expect(c.get('src/a/b.py')).toBe(0);
    });

    it.each(['import os\n', 'from os import path\n', 'import os.path\n'])(
      'does not bind %j to py/os.py',
      (body) => {
        const c = counts({ 'py/os.py': '', 'src/m.py': body });
        expect(c.get('py/os.py')).toBe(0);
      },
    );

    it('still binds a relative import of a stdlib-named file', () => {
      const c = counts({ 'py/os.py': '', 'py/m.py': 'from .os import x\n' });
      expect(c.get('py/os.py')).toBe(1);
    });
  });

  describe('extra targets', () => {
    const tree = (files: Record<string, string>): void => {
      for (const [path, body] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), body, 'utf-8');
      }
    };

    it('counts a candidate importing an extra', () => {
      tree({
        'tests/helper.ts': '',
        'src/uses.ts': "import '../tests/helper.js';\n",
      });
      const c = countImporters(
        root,
        ['src/uses.ts'],
        ['tests/helper.ts'],
      ).counts!;
      expect(c.get('tests/helper.ts')).toBe(1);
    });

    it('never treats an extra as an importer (D7)', () => {
      tree({
        'src/a.ts': '',
        'tests/x.test.ts': "import '../src/a.js';\n",
      });
      const c = countImporters(root, ['src/a.ts'], ['tests/x.test.ts']).counts!;
      expect(c.get('src/a.ts')).toBe(0);
      expect(c.get('tests/x.test.ts')).toBe(0);
    });

    it('does not make a candidate suffix ambiguous', () => {
      tree({
        'src/util.py': '',
        'tests/util.py': '',
        'src/m.py': 'import util\n',
      });
      const c = countImporters(
        root,
        ['src/util.py', 'src/m.py'],
        ['tests/util.py'],
      ).counts!;
      expect(c.get('src/util.py')).toBe(1);
      expect(c.get('tests/util.py')).toBe(0);
    });
  });

  describe('PHP', () => {
    it.each(['#', '//', '*', '/*'])('skips a whole-line %s comment', (mark) => {
      const c = counts({
        'web/x.php': '',
        'web/m.php': `<?php\n${mark} require 'x.php';\n`,
      });
      expect(c.get('web/x.php')).toBe(0);
    });

    it('counts require_once of a path relative to the file', () => {
      const c = counts({
        'web/lib/x.php': '',
        'web/m.php': "<?php\nrequire_once 'lib/x.php';\n",
      });
      expect(c.get('web/lib/x.php')).toBe(1);
    });

    it('counts include with parentheses', () => {
      const c = counts({
        'web/x.php': '',
        'web/m.php': "<?php\ninclude('x.php');\n",
      });
      expect(c.get('web/x.php')).toBe(1);
    });

    it('counts a use statement by unique suffix', () => {
      const c = counts({
        'src/App/Billing/Charge.php': '',
        'web/m.php': '<?php\nuse App\\Billing\\Charge;\n',
      });
      expect(c.get('src/App/Billing/Charge.php')).toBe(1);
    });
  });

  it('does not match across languages', () => {
    const c = counts({ 'a.ts': '', 'm.py': 'import a\n' });
    expect(c.get('a.ts')).toBe(0);
  });

  describe('files that cannot be read', () => {
    const tree = (files: Record<string, string>): string[] => {
      for (const [path, body] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), body, 'utf-8');
      }
      return Object.keys(files);
    };

    it('is unmeasured, not 0, when none could be', () => {
      const { counts, source } = countImporters(root, ['gone.ts', 'lost.py']);
      expect(counts).toBeNull();
      expect(source.status).toBe('absent');
      expect(source.reason).toMatch(/0 of 2/);
      expect(source.files_read).toBe(0);
      expect(source.files_unread).toBe(2);
    });

    it('is partial when some could be, and counts what was read', () => {
      const files = tree({ 'a.ts': '', 'b.ts': "import './a.js';\n" });
      const { counts, source } = countImporters(root, [...files, 'gone.ts']);
      expect(counts!.get('a.ts')).toBe(1);
      expect(counts!.get('gone.ts')).toBe(0);
      expect(source.status).toBe('partial');
      expect(source.reason).toMatch(/1 of 3/);
      expect(source.files_read).toBe(2);
      expect(source.files_unread).toBe(1);
    });

    it('is measured when all could be', () => {
      const files = tree({ 'a.ts': '', 'b.ts': "import './a.js';\n" });
      expect(countImporters(root, files).source).toEqual({
        status: 'measured',
        files_read: 2,
        files_unread: 0,
      });
    });

    it('never counts an extra as a file that failed to read', () => {
      const files = tree({ 'a.ts': '' });
      const { source } = countImporters(root, files, ['tests/gone.ts']);
      expect(source.status).toBe('measured');
      expect(source.files_unread).toBe(0);
    });
  });

  it('gives every listed file a key, 0 when nothing imports it', () => {
    const c = counts({ 'a.ts': '', 'b.py': '', 'c.php': '' });
    expect([...c.entries()].sort()).toEqual([
      ['a.ts', 0],
      ['b.py', 0],
      ['c.php', 0],
    ]);
  });
});
