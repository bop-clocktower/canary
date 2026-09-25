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
