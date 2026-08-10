import { describe, expect, it } from 'vitest';

import { blankStringContent } from '../src/core/string-literals.js';

/** The invariant every caller depends on: offsets and line numbers survive. */
function expectShapePreserved(code: string, out: string): void {
  expect(out).toHaveLength(code.length);
  expect(out.split('\n')).toHaveLength(code.split('\n').length);
}

/** Spell an expected result without hand-counting spaces. */
function blanked(text: string): string {
  return ' '.repeat(text.length);
}

describe('blankStringContent', () => {
  it('preserves length and line count so offsets stay valid', () => {
    const code = "const a = 'xyz';\nconst b = `q`;\n";
    expectShapePreserved(code, blankStringContent(code));
  });

  it('blanks single-quoted, double-quoted and template content alike', () => {
    expect(blankStringContent("a('one')")).toBe("a('   ')");
    expect(blankStringContent('a("one")')).toBe('a("   ")');
    expect(blankStringContent('a(`one`)')).toBe('a(`   `)');
  });

  it('leaves the quote characters themselves in place', () => {
    // Rules that key off the DELIMITER (a brittle selector written as '.btn')
    // can still see that a string was there; only its contents go away.
    expect(blankStringContent("x = '.btn'")).toBe("x = '    '");
  });

  it('blanks a template literal that opens and closes on one line', () => {
    // The exact #590 seam: blankMultilineStrings only toggles on an ODD
    // delimiter count, so this line was skipped entirely.
    const body = "test('a', () => {});";
    expect(blankStringContent(`const f = \`${body}\`;`)).toBe(
      `const f = \`${blanked(body)}\`;`,
    );
  });

  it('blanks across the interior of a genuinely multi-line template', () => {
    const inner = "it('x', () => {});";
    const code = ['const d = `', inner, '`;'].join('\n');
    const out = blankStringContent(code);
    expectShapePreserved(code, out);
    expect(out.split('\n')[1]).toBe(blanked(inner));
  });

  it('treats ${...} interpolation as code, not string content', () => {
    // The interpolated expression is real code and must stay readable, or a
    // rule inside a template-built assertion goes dark.
    const code = 'const s = `a${expect(1)}b`;';
    const out = blankStringContent(code);
    expect(out).toContain('expect(1)');
    expectShapePreserved(code, out);
  });

  it('handles a nested string inside an interpolation', () => {
    const code = "const s = `a${fn('b')}c`;";
    const out = blankStringContent(code);
    expectShapePreserved(code, out);
    expect(out).toContain("fn(' ')");
  });

  it('respects backslash escapes, so an escaped quote does not close', () => {
    const code = "const s = 'a\\'b'; const t = 'c';";
    expect(blankStringContent(code)).toBe("const s = '    '; const t = ' ';");
  });

  it('keeps a quote of the other kind as content', () => {
    const inner = "it('a')";
    expect(blankStringContent(`x = "${inner}"`)).toBe(
      `x = "${blanked(inner)}"`,
    );
  });

  it('does NOT blank to end of file on an unterminated quote', () => {
    // Blanking an unclosed run to EOF would silently disable every downstream
    // rule from that point on -- the abstention shape, inside the linter. An
    // unclosed frame is discarded instead, matching blankMultilineStrings.
    // A bare backtick in CODE (not a comment) is the case that reaches the
    // discard path; the declaration below it must stay fully readable.
    const code = ['const x = 1; `', "it('y', () => { expect(1); });"].join(
      '\n',
    );
    const out = blankStringContent(code);
    expectShapePreserved(code, out);
    expect(out).toContain('it(');
    expect(out).toContain('expect(1)');
  });

  it('does not let a stray backtick in a comment open a literal at all', () => {
    // Comment-skipping means this never even reaches the discard path. The
    // real `'y'` argument still blanks -- suppression must stay scoped to
    // string CONTENT, not spread to the code around it.
    const code = ['// a stray ` in a comment', "it('y', () => {});"].join('\n');
    const out = blankStringContent(code);
    expect(out.split('\n')[0]).toBe('// a stray ` in a comment');
    expect(out.split('\n')[1]).toBe("it(' ', () => {});");
  });

  it('ignores quotes inside a line comment', () => {
    // An apostrophe in prose ("don't") would otherwise open a phantom string
    // and blank real code until the next quote.
    const code = ["// don't do this", "it('x', () => { expect(1); });"].join(
      '\n',
    );
    const out = blankStringContent(code);
    expect(out.split('\n')[0]).toBe("// don't do this");
    expect(out).toContain('expect(1)');
  });

  it('ignores quotes inside a block comment', () => {
    const code = "/* don't */ it('x', () => {});";
    expect(blankStringContent(code)).toBe("/* don't */ it(' ', () => {});");
  });

  it('blanks python triple-quoted blocks when python is set', () => {
    const code = ['DIFF = """', 'def test_x():', '"""', 'assert 1'].join('\n');
    const out = blankStringContent(code, { python: true });
    expectShapePreserved(code, out);
    expect(out).not.toContain('def test_x');
    expect(out).toContain('assert 1');
  });

  it('treats # as a comment only in python mode', () => {
    // `#` opens a private field in JS, so it must not eat the rest of the line
    // there; in Python it is a comment and its apostrophes are prose.
    expect(blankStringContent("obj.#x = 'a';")).toBe("obj.#x = ' ';");
    const out = blankStringContent("# don't\nx = 'a'", { python: true });
    expect(out.split('\n')[0]).toBe("# don't");
    expect(out.split('\n')[1]).toBe("x = ' '");
  });

  it('is a no-op on source containing no strings', () => {
    const code = 'const a = 1 + 2;\nconst b = a * 3;\n';
    expect(blankStringContent(code)).toBe(code);
  });
});
