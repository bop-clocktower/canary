/**
 * #1515: `stripComments` read `//` and `/*` inside a regex literal as comment
 * openers. Both callers of that one function are pinned here, because the same
 * bug has a different cost in each.
 *
 * - The continuation lexer lost the rest of the line, saw an open paren and
 *   fell back to "nearest record above" for the whole file: noisy, fail closed.
 * - The type-only detector lost real code, so a module could be proven
 *   type-only with a runtime statement in it: a suppressed finding, fail open.
 *
 * Telling a regex from division is a guess, so each wrong guess is pinned too.
 * A division read as a regex keeps comment text as code (noise). A regex read as
 * division still drops text, as every regex did before, so the detector below
 * has to refuse what that leaves behind.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { attributeLines } from '../src/guardian/diff-coverage/lexical/continuation.js';
import {
  isTypeOnlyModule,
  stripComments,
} from '../src/guardian/diff-coverage/type-only.js';

/** The line from `report-anchor.ts` that #1515 was found on. */
const TRIGGER = "const clean = p.replace(/^\\.\\//, '');";

describe('stripComments: a regex literal is code', () => {
  it.each([
    ['ending in an escaped slash (#1515)', TRIGGER],
    ['with `/` in a character class', "s.replace(/[/]/g, '-');"],
    ['with `//` in a character class', 'const r = /[//]/;'],
    ['with `/*` in a character class', 'const r = /[/*]/;'],
    ['with `/*` after an escaped slash', 'const r = /a\\/*b/;'],
    ['with a quote in it', "const q = /'/; const s = '//';"],
    ['after a return', 'return /\\/\\//.test(s);'],
    ['at the very start of a file', '/\\/\\//.test(s);'],
  ])('%s', (_name, line) => {
    expect(stripComments(line)).toBe(line);
  });

  it('after a block comment', () => {
    expect(stripComments('const r = /* a */ /\\/\\//;')).toBe(
      'const r =  /\\/\\//;',
    );
  });

  it('keeps the regex-or-division context across a line break', () => {
    const source = 'const r =\n  /^\\.\\//;\nconst t = 1;';
    expect(stripComments(source)).toBe(source);
  });

  it('keeps the context across a block comment that spans lines', () => {
    const source = 'const r = /* one\n  two */ /^\\.\\//;';
    expect(stripComments(source)).toBe('const r = \n /^\\.\\//;');
  });

  it('a `/*` inside a regex does not blank the following lines', () => {
    const source = 'const r = /a\\/*b/;\nregister();\nconst s = 1; // */';
    expect(stripComments(source)).toBe(
      'const r = /a\\/*b/;\nregister();\nconst s = 1; ',
    );
  });
});

describe('stripComments: a real comment is still a comment', () => {
  it.each([
    ['after a regex', 'const r = /x\\//; // note', 'const r = /x\\//; '],
    ['directly after a regex', 'const r = /x\\///// note', 'const r = /x\\//'],
    ['block, after a regex', 'f(/x\\//, /* a */ 1);', 'f(/x\\//,  1);'],
    ['after a quote in a regex', "f(/'/); // it's", "f(/'/); "],
    ['after a division', 'const c = a / b // note', 'const c = a / b '],
    ['after two divisions', 'a / b / c // note', 'a / b / c '],
    ['after a called division', 'f(a) / g(b) // note', 'f(a) / g(b) '],
    ['after an indexed division', 'a[0] / 2 // note', 'a[0] / 2 '],
    ['after a member division', 'a.length / 2 // note', 'a.length / 2 '],
    ['where a regex could start', 'const r = // note', 'const r = '],
    ['block, where a regex could start', 'f(/* a */ 1)', 'f( 1)'],
    ['after a string', "type A = 'x' // note", "type A = 'x' "],
    ['after a string, block', "f('x' /* a */)", "f('x' )"],
  ])('%s', (_name, line, expected) => {
    expect(stripComments(line)).toBe(expected);
  });

  it('a `/*` after a division still opens a block comment', () => {
    expect(stripComments('a / b /* one\ntwo */ + c')).toBe('a / b \n + c');
  });

  it('does not let a comment supply the regex-or-division context', () => {
    // The `=` is in the comment, so the `/` after `a` is still a division.
    expect(stripComments('a /* = */ / b // note')).toBe('a  / b ');
  });
});

describe('stripComments: slashes in strings and templates', () => {
  it.each([
    [
      'single quotes',
      "const u = 'http://x'; // note",
      "const u = 'http://x'; ",
    ],
    ['double quotes', 'const g = "**/*.ts"; // note', 'const g = "**/*.ts"; '],
    ['a template', 'const u = `http://x`; // note', 'const u = `http://x`; '],
    [
      'a template hole',
      'const p = `${a}/${b}`; // note',
      'const p = `${a}/${b}`; ',
    ],
    [
      'an escaped quote',
      "const s = 'a\\'//b'; // note",
      "const s = 'a\\'//b'; ",
    ],
    ['a string before a regex', "f('/', /\\//); // note", "f('/', /\\//); "],
  ])('%s', (_name, line, expected) => {
    expect(stripComments(line)).toBe(expected);
  });
});

describe('stripComments: a wrong guess keeps code rather than dropping it', () => {
  it.each([
    // The rule has no `++` case, so this division reads as a regex.
    ['a division after `++`', 'i++ / 2 // note'],
    // A string does not update the context, so `=` still precedes this `/`.
    ['a division after a string', "const x = 'a' / b // note"],
    // TSX, with the same stale context.
    ['a closing tag', '</div> // note'],
  ])('%s: the comment text stays, as code', (_name, line) => {
    expect(stripComments(line)).toBe(line);
  });

  it('a block comment after a misread division stays code, not hidden', () => {
    const source = 'i++ / 2 /* one\nregister();\n*/';
    expect(stripComments(source)).toBe(source);
  });

  it('a regex misread as division loses only its own line', () => {
    // No rule entry for `)`: `if (x) /re/` reads as division. The rest of the
    // line goes, as it did before #1515, and the next line is still code.
    expect(stripComments('if (x) /a\\//.test(y);\nregister();')).toBe(
      'if (x) /a\\\nregister();',
    );
  });
});

describe('stripComments: the known limit of a regex read as division', () => {
  it('a `/*` in one blanks the lines up to the next `*/`', () => {
    // Unchanged by #1515, and only after `)` or a keyword the rule lacks. The
    // type-only detector refuses the `/` this leaves; the continuation lexer
    // sees blank lines, which the PR records as an unresolved finding.
    expect(stripComments('if (x) /a\\/*b/.test(y);\nrun();\n// */\nz();')).toBe(
      'if (x) /a\\\n\n\nz();',
    );
  });
});

describe('continuation lexer: a regex no longer costs the whole file', () => {
  /** Line 3 belongs to line 4's statement; "nearest above" would say line 2. */
  const withLine2 = (line2: string): string =>
    [
      'export function f(p: string): string {',
      line2,
      '  const value =',
      '    compute(p);',
      '  return value;',
      '}',
    ].join('\n');
  const MEASURED = new Set([2, 4, 5]);

  it.each([
    ['the #1515 trigger', `  ${TRIGGER}`],
    ['a comment after a regex', "  const c = p.replace(/\\//g, ''); // note ("],
    ['`/` in a character class', "  const c = p.replace(/[/(]/g, '');"],
    ['`/*` in a regex', '  const c = /a\\/*(/.test(p);'],
    ['a comment after a division', '  const c = p.length / 2; // note ('],
    ['slashes in a string', "  const c = 'http://('; // note ("],
    ['slashes in a template', '  const c = `http://(`; // note ('],
  ])('groups statements after %s', (_name, line2) => {
    const at = attributeLines([3], MEASURED, withLine2(line2));
    expect(at?.get(3)).toBe(4);
  });

  it('a regex misread as division still falls back, to the noisy answer', () => {
    // After `)` the rule says division, so the regex's `//` strips the line and
    // the regex's own `(` stays open.
    const source = withLine2('  if (p) /\\(\\//.test(p);');
    expect(attributeLines([3], MEASURED, source)?.get(3)).toBe(2);
  });

  it('a wrong guess that keeps comment text does not lose the file', () => {
    // Both passes read this line the same way, so the kept `(` stays skipped.
    const at = attributeLines([3], MEASURED, withLine2('  i++ / 2 // note ('));
    expect(at?.get(3)).toBe(4);
  });
});

describe('type-only detector: a regex cannot hide a runtime statement', () => {
  let root: string;

  function typeOnly(body: string): boolean {
    const rel = 'src/shape.types.ts';
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, rel), body, 'utf-8');
    return isTypeOnlyModule(rel, root);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'canary-type-only-regex-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('a `//` in a regex does not hide the rest of its line', () => {
    expect(typeOnly("export type A = /\\//; register('x');\n")).toBe(false);
  });

  it('a `/*` in a regex does not hide the following lines', () => {
    const body = "export type A = /a\\/*b/;\nregister('x');\n// */\n";
    expect(typeOnly(body)).toBe(false);
  });

  it('a regex at the top level is runtime', () => {
    expect(typeOnly("/\\//.test('x');\n")).toBe(false);
  });

  // A type has no division or regex, so whatever `/` survives stripping is the
  // proof. These pass the bracket count once the slashes are kept or dropped.
  it.each([
    [
      'a regex read as division, `//`',
      "export type A = B /\\//; register('x');",
    ],
    [
      'a regex read as division, `/*`',
      "export type A = B /a\\/*b/;\nregister('x');\n// */",
    ],
    ['a regex with a quote in it', "export type A = /'/; register('x');"],
    ['a regex balancing a bracket', "export type A = /(//)register('x');"],
    ['a regex hiding a closer', 'export type A = /(/*]'],
    ['a `/` in a multi-line template', 'export type A = `a\n/b`;'],
  ])('any `/` left in the code keeps the finding: %s', (_name, body) => {
    expect(typeOnly(`${body}\n`)).toBe(false);
  });

  it('a comment kept as code by a wrong guess keeps the finding', () => {
    expect(typeOnly("export type A = 'a' / 2; // note\n")).toBe(false);
  });

  it('a block comment a wrong guess did not open exposes what follows', () => {
    const body = "export type A = 'a' / 2; /* one\nregister('x');\n*/\n";
    expect(typeOnly(body)).toBe(false);
  });

  it.each([
    ['a line comment', 'export type A = string; // see /a/b\n'],
    ['a slash in a string type', "export type A = 'a//b' | '/*'; // note\n"],
    ['a JSDoc block', '/**\n * a / b // c\n */\nexport type A = string;\n'],
    ['a comment in a body', "export interface A {\n  p: '/x'; // q / r\n}\n"],
    ['a template type', 'export type A = `/${string}//`; // note\n'],
    ['a block comment before a type', '/* a */ export type A = string;\n'],
  ])('a real type module stays type-only: %s', (_name, body) => {
    expect(typeOnly(body)).toBe(true);
  });
});
