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
