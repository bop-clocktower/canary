// canary-savant PHP support (#1106): PHPUnit and WordPress idioms for the
// static pass (SV001-SV004). Spec: docs/changes/1106-savant-php/proposal.md.
//
// CI TRAP: savant and blackhawk scan THIS file with --strict. Every PHP
// fixture line is its own single-line string literal, joined with '\n'. A
// multi-line template literal's continuation lines would read as CODE and
// fire on canary's own suite.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  scanText,
  scanPaths,
} from '../claude-code/canary-savant/scripts/scanner.mjs';
import { classifyMutation } from '../claude-code/canary-savant/scripts/restoration.mjs';
import { stringLiteralRanges } from '../claude-code/canary-savant/scripts/string-literals.mjs';

// Braced bodies on purpose (see canary-savant.restoration.test.ts, #495).
const php = (...lines: string[]) => {
  return ['<?php', ...lines].join('\n');
};

// --- Test-file discovery (D11) ---------------------------------------------

function withTree(files: string[], fn: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'savant-php-'));
  try {
    for (const rel of files) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, php('echo 1;'));
    }
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('PHP test-file discovery (#1106 D11)', () => {
  it('walks FooTest.php, test-foo.php and .php under tests/, nothing else', () => {
    const files = [
      'plugin/FooTest.php',
      'plugin/test-foo.php',
      'tests/unit/Bar.php',
      'src/Foo.php',
      'plugin/helper.php',
    ];
    withTree(files, (root) => {
      expect(scanPaths([root]).filesScanned).toBe(3);
    });
  });

  it('never walks vendor/, even its test files', () => {
    const files = ['vendor/acme/tests/VendorTest.php', 'vendor/acme/a.test.js'];
    withTree(files, (root) => {
      expect(scanPaths([root]).filesScanned).toBe(0);
    });
  });

  it('scans a .php file named explicitly, whatever its name', () => {
    withTree(['src/Foo.php'], (root) => {
      const file = path.join(root, 'src', 'Foo.php');
      expect(scanPaths([file]).filesScanned).toBe(1);
    });
  });
});

// Line 1 `<?php`, line 2 the class head, line 3 `{`, body from line 4.
const inClass = (body: string[], head = 'class FooTest extends TestCase') => {
  return php(head, '{', ...body, '}');
};
// `line:rule` pairs, e.g. ['4:SV003'], so every assertion pins the line.
const hits = (text: string, name = 'FooTest.php') => {
  return scanText(text, name).map((f) => `${f.line}:${f.ruleId.slice(0, 5)}`);
};

// --- SV002 (D6) ------------------------------------------------------------

describe('SV002 PHP class-scoped pairs (#1106 D6)', () => {
  it.each([
    ['setUpBeforeClass', 'tearDownAfterClass'],
    ['set_up_before_class', 'tear_down_after_class'],
  ])('%s without %s fires; with it, silent', (setup, teardown) => {
    const up = `    public static function ${setup}(): void {}`;
    const down = `    public static function ${teardown}(): void {}`;
    expect(hits(inClass([up]))).toEqual(['4:SV002']);
    expect(hits(inClass([up, down]))).toEqual([]);
  });

  it.each(['setUp', 'set_up'])('per-test %s alone is silent', (setup) => {
    expect(
      hits(inClass([`    protected function ${setup}(): void {}`])),
    ).toEqual([]);
  });

  // Amended at plan approval: WP's base tear_down_after_class deletes the
  // factory data wpSetUpBeforeClass builds, so it needs no teardown of its own.
  it('wpSetUpBeforeClass alone is silent (the WP base cleans up)', () => {
    const up =
      '    public static function wpSetUpBeforeClass(WP_UnitTest_Factory $f) {}';
    expect(
      hits(inClass([up], 'class Tests_Foo extends WP_UnitTestCase')),
    ).toEqual([]);
  });

  it('a setup named only in a comment or a string does not fire', () => {
    const body = [
      '    // public static function setUpBeforeClass(): void {}',
      "    private $doc = 'function setUpBeforeClass()';",
    ];
    expect(hits(inClass(body))).toEqual([]);
  });

  it('a teardown named only in a comment does not pair', () => {
    const body = [
      '    public static function setUpBeforeClass(): void {}',
      '    // tearDownAfterClass() is inherited',
    ];
    expect(hits(inClass(body))).toEqual(['4:SV002']);
  });
});

// --- SV003 families (D7) ---------------------------------------------------

const classifyPhp = (line: string) => {
  return classifyMutation(line, stringLiteralRanges(line), true);
};

describe('classifyMutation: PHP families (#1106 D7)', () => {
  it.each([
    ["$_GET['q'] = 'x';", '$_GET', 'q'],
    ["$_SERVER['HTTP_HOST'] = 'example.org';", '$_SERVER', 'HTTP_HOST'],
    ["$_SESSION['a']['b'] = 1;", '$_SESSION', 'a'],
    ["$_COOKIE['c'] .= 'x';", '$_COOKIE', 'c'],
    ["$_REQUEST['r'] ??= 1;", '$_REQUEST', 'r'],
    ['$_FILES[] = $upload;', '$_FILES', null],
    ['$_POST = [];', '$_POST', null],
    ["$_ENV['APP_ENV'] = 'test';", '$_ENV', 'APP_ENV'],
    ["$GLOBALS['wp_rewrite'] = null;", '$GLOBALS', 'wp_rewrite'],
    ["putenv('APP_ENV=test');", 'putenv', 'APP_ENV'],
    ["ini_set('precision', '4');", 'ini_set', 'precision'],
    ["date_default_timezone_set('UTC');", 'date_default_timezone_set', null],
    ["define('WP_DEBUG', true);", 'define', 'WP_DEBUG'],
    [
      "add_filter('the_title', '__return_empty_string');",
      'wp.hooks',
      'the_title',
    ],
    ["add_action( 'init', 'boot' );", 'wp.hooks', 'init'],
    ["update_option('blogname', 'x');", 'wp.options', 'blogname'],
    ["add_option('k', 1);", 'wp.options', 'k'],
  ])('classifies %s as %s', (line, family, key) => {
    expect(classifyPhp(line)).toMatchObject({ family, key });
  });

  it.each([
    "if ($_GET['q'] == 'x') {}",
    "$same = $_GET['q'] === 'x';",
    "$q = $_GET['q'];",
    "$pairs = [$_GET['q'] => 1];",
    '$_GETX = 1;',
    "if (!defined('WP_DEBUG')) {}",
    "$this->define('X', 1);",
    "Foo::define('X', 1);",
    "$v = get_option('blogname');",
  ])('returns null for the read or comparison %s', (line) => {
    expect(classifyPhp(line)).toBeNull();
  });

  it('never applies a PHP family outside .php (a JS define( is AMD)', () => {
    const lines = [
      "define(['dep'], factory);",
      "$_GET['q'] = 1;",
      "add_filter('x', cb);",
    ];
    for (const line of lines) {
      expect(classifyMutation(line, stringLiteralRanges(line))).toBeNull();
    }
  });
});

describe('SV003 PHP in the scanner (#1106)', () => {
  it('a superglobal write with no restore fires on its line', () => {
    const body = [
      '    public function test_a(): void',
      '    {',
      "        $_GET['q'] = 'x';",
      '    }',
    ];
    expect(hits(inClass(body))).toEqual(['6:SV003']);
  });

  it.each([
    "$_SERVER['X'] .= 'y';",
    '$_SESSION[] = 1;',
    '$_POST = [];',
    "define('FOO', 1);",
    "putenv('APP_ENV=test');",
    "ini_set('precision', '4');",
    "date_default_timezone_set('UTC');",
    "add_filter('the_title', 'x');",
    "update_option('blogname', 'x');",
  ])('%s with no restore fires', (stmt) => {
    expect(hits(inClass([`        ${stmt}`]))).toEqual(['4:SV003']);
  });

  it('a restore in a finally block is silent', () => {
    const body = [
      '    public function test_a(): void',
      '    {',
      '        try {',
      "            $_GET['q'] = 'x';",
      '        } finally {',
      "            unset($_GET['q']);",
      '        }',
      '    }',
    ];
    expect(hits(inClass(body))).toEqual([]);
  });

  it('the snapshot write-back line itself is silent', () => {
    const body = [
      '    public function test_a(): void',
      '    {',
      '        $saved = $_SERVER;',
      "        $_SERVER['HTTPS'] = 'on';",
      '        $_SERVER = $saved;',
      '    }',
    ];
    // Only the HTTPS write (line 7); the write-back on line 8 is the restore.
    expect(hits(inClass(body))).toEqual(['7:SV003']);
  });

  it('reads and comparisons never fire', () => {
    const body = [
      "        $q = $_GET['q'];",
      "        if ($_GET['q'] === 'x') {}",
      "        if (!defined('X')) {}",
    ];
    expect(hits(inClass(body))).toEqual([]);
  });

  it('a token in a comment never fires', () => {
    const body = [
      "        // $_GET['q'] = 'x';",
      "        # putenv('A=1');",
      "        /* define('X', 1); */",
      "         * add_filter('a', 'b');",
    ];
    expect(hits(inClass(body))).toEqual([]);
  });

  it('a token in a string never fires', () => {
    const body = [
      '        $s = "$_GET[\'q\'] = 1";',
      '        $t = \'putenv("A=1")\';',
    ];
    expect(hits(inClass(body))).toEqual([]);
  });

  it('JS and Python files keep ignoring PHP tokens', () => {
    expect(hits("define(['a'], function (a) {});", 'a.test.js')).toEqual([]);
    expect(hits("$_GET['q'] = 1;", 'a.test.js')).toEqual([]);
    expect(hits("os.putenv('A=1')", 'test_a.py')).toEqual([]);
  });
});

// --- SV003 restore evidence (D8) -------------------------------------------

describe('SV003 PHP teardown regions (#1106 D8)', () => {
  it('an unset in tearDown (Allman brace) restores the key', () => {
    const body = [
      "    public function test_a(): void { $_GET['q'] = 'x'; }",
      '    protected function tearDown(): void',
      '    {',
      "        unset($_GET['q']);",
      '    }',
    ];
    expect(hits(inClass(body))).toEqual([]);
  });

  it('a whole-family reassign in tear_down restores every key', () => {
    const body = [
      "    public function test_a() { $_COOKIE['c'] = 1; }",
      '    public function tear_down() {',
      '        $_COOKIE = [];',
      '    }',
    ];
    expect(hits(inClass(body))).toEqual([]);
  });

  it('wpTearDownAfterClass is a teardown region', () => {
    const body = [
      "    public static function wpSetUpBeforeClass() { $GLOBALS['x'] = 1; }",
      '    public static function wpTearDownAfterClass() {',
      "        unset($GLOBALS['x']);",
      '    }',
    ];
    expect(hits(inClass(body))).toEqual([]);
  });

  it('a restore of a different key leaves the write flagged', () => {
    const body = [
      "    public function test_a() { $_GET['a'] = 1; }",
      '    protected function tearDown(): void {',
      "        unset($_GET['b']);",
      '    }',
    ];
    expect(hits(inClass(body))).toEqual(['4:SV003']);
  });

  it('the region ends at the method close brace', () => {
    const body = [
      '    protected function tearDown(): void {',
      '        parent::tearDown();',
      '    }',
      "    public function test_a() { $_GET['a'] = 1; }",
    ];
    expect(hits(inClass(body))).toEqual(['7:SV003']);
  });

  it('a bodiless abstract teardown opens no region', () => {
    const text = php(
      'abstract class BaseTest extends TestCase',
      '{',
      '    abstract protected function tearDownFixture(): void;',
      "    public function helper() { unset($_GET['a']); }",
      "    public function test_a() { $_GET['a'] = 1; }",
      '}',
    );
    expect(hits(text, 'BaseTest.php')).toEqual(['6:SV003']);
  });

  it('a teardown token inside a string opens no region', () => {
    const body = [
      "    private $doc = 'function tearDown() {';",
      "    public function helper() { unset($_GET['a']); }",
      "    public function test_a() { $_GET['a'] = 1; }",
    ];
    expect(hits(inClass(body))).toEqual(['6:SV003']);
  });

  it.each([
    ["putenv('APP_ENV=test');", "putenv('APP_ENV');"],
    ["ini_set('precision', '4');", "ini_restore('precision');"],
    ["ini_set('precision', '4');", "ini_set('precision', $this->old);"],
    [
      "date_default_timezone_set('UTC');",
      'date_default_timezone_set($this->tz);',
    ],
    ["update_option('blogname', 'x');", "delete_option('blogname');"],
    ["$_SERVER['HTTPS'] = 'on';", '$_SERVER = $this->server;'],
  ])('%s is restored by %s in tearDown', (write, restore) => {
    const body = [
      `    public function test_a() { ${write} }`,
      '    protected function tearDown(): void {',
      `        ${restore}`,
      '    }',
    ];
    expect(hits(inClass(body))).toEqual([]);
  });
});

describe('SV003 PHP restore policy (#1106 D7/D8)', () => {
  it('define fires even when a teardown redefines it (unrestorable)', () => {
    const body = [
      "    public function test_a() { define('FOO', 1); }",
      '    protected function tearDown(): void {',
      "        define('FOO', 2);",
      '    }',
    ];
    expect(hits(inClass(body))).toEqual(['4:SV003', '6:SV003']);
  });

  it.each([
    ["add_filter('the_title', 'x');", "remove_filter('the_title', 'x');"],
    ["add_action('init', 'boot');", "remove_action('init', 'boot');"],
    ["add_filter('the_title', 'x');", "remove_all_filters('the_title');"],
    ["add_action('init', 'boot');", "remove_all_actions('init');"],
  ])('%s is paired by %s anywhere in the file', (add, remove) => {
    const body = [
      '    public function test_a(): void',
      '    {',
      `        ${add}`,
      '        $this->assertTrue(true);',
      `        ${remove}`,
      '    }',
    ];
    expect(hits(inClass(body))).toEqual([]);
  });

  it('a remove for another hook leaves the add flagged', () => {
    const body = [
      "        add_action('init', 'boot');",
      "        remove_action('wp_head', 'boot');",
    ];
    expect(hits(inClass(body))).toEqual(['4:SV003']);
  });

  it('a commented-out remove_filter does not pair', () => {
    const body = [
      "        add_filter('the_title', 'x');",
      "        // remove_filter('the_title', 'x');",
    ];
    expect(hits(inClass(body))).toEqual(['4:SV003']);
  });

  it('an add_filter inside tearDown is not its own restore', () => {
    const body = [
      '    protected function tearDown(): void {',
      "        add_filter('a', 'b');",
      '    }',
    ];
    expect(hits(inClass(body))).toEqual(['5:SV003']);
  });
});

describe('WP_UnitTestCase auto-restore (#1106 D9)', () => {
  const wp = 'class Tests_Foo extends WP_UnitTestCase';

  it('hooks and options are restored by the framework', () => {
    const body = [
      "        add_filter('the_title', 'x');",
      "        update_option('blogname', 'x');",
    ];
    expect(hits(inClass(body, wp))).toEqual([]);
  });

  it('superglobals are NOT restored by the framework', () => {
    expect(hits(inClass(["        $_GET['a'] = 1;"], wp))).toEqual(['4:SV003']);
  });

  it.each([
    'class Tests_Foo extends \\WP_UnitTestCase',
    'class Tests_Ajax extends WP_Ajax_UnitTestCase',
    'class Tests_Base extends WP_UnitTestCase_Base',
    'abstract class Tests_Base extends WP_UnitTestCase',
  ])('%s counts as a WP base', (head) => {
    expect(
      hits(inClass(["        add_action('init', 'boot');"], head)),
    ).toEqual([]);
  });

  it('a base named only in a comment does not count', () => {
    const text = php(
      '// class Old extends WP_UnitTestCase',
      'class FooTest extends TestCase',
      '{',
      "    public function test_a() { add_filter('a', 'b'); }",
      '}',
    );
    expect(hits(text)).toEqual(['5:SV003']);
  });
});
