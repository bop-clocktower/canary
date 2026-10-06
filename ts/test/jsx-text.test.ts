/**
 * JSX text is prose, not code (#1180).
 *
 * The string blankers and the rule regexes read raw source, so JSX children
 * text broke them two ways: an apostrophe (`<p>It's</p>`) opened a phantom
 * string that swallowed the next line's `expect(...)`, and plain English
 * ("...as you should.") matched assertion and timing rules. `maskJsxText`
 * blanks every non-newline character of JSX children text, preserving length
 * and line breaks, so the blankers run on `.tsx`/`.jsx` exactly as they do on
 * `.ts`/`.js`.
 *
 * Most cases below are the review findings on #1180's first cut, where a
 * construct the masker misread made it fall back to the unmasked source for
 * the WHOLE file -- silently restoring the bug for that file.
 */
import { describe, expect, it } from 'vitest';

import { maskJsxText } from '../src/core/jsx-text.js';
import { blankStringContent } from '../src/core/string-literals.js';

function expectShapePreserved(code: string, out: string): void {
  expect(out).toHaveLength(code.length);
  expect(out.split('\n').map((l) => l.length)).toEqual(
    code.split('\n').map((l) => l.length),
  );
}

/** `text` with every non-newline character replaced by a space. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

const RTL = `import { render, screen } from '@testing-library/react';
import { Button } from './Button';

it("shows the label", () => {
  render(<Button label="Don't stop" onClick={() => {}}><p>It's {count} items</p></Button>);
  expect(screen.getByText("It's 3 items")).toBeInTheDocument();
});
`;

/** Asserts `text` (which must occur once in `code`) comes out blanked. */
function expectMaskedText(code: string, text: string): void {
  const out = maskJsxText(code);
  expectShapePreserved(code, out);
  const at = code.indexOf(text);
  expect(at).toBeGreaterThanOrEqual(0);
  expect(out.slice(at, at + text.length)).toBe(blank(text));
}

describe('maskJsxText', () => {
  it('blanks JSX children text, keeping tags, attributes and containers', () => {
    const out = maskJsxText(RTL);
    expectShapePreserved(RTL, out);
    expect(out).toContain(`<p>${blank("It's ")}{count}${blank(' items')}</p>`);
    expect(out).toContain('label="Don\'t stop"');
    expect(out).toContain('expect(screen.getByText("It\'s 3 items"))');
  });

  it('blanks prose that would otherwise read as an assertion or a timing value', () => {
    expectMaskedText(
      `it('a', () => {\n  render(<Notice>Your session timeout is 45 minutes, so save as you should.</Notice>);\n});\n`,
      'Your session timeout is 45 minutes, so save as you should.',
    );
  });

  it('handles nested elements, expression containers and fragments', () => {
    const code = `render(<ul>{items.map((i) => <li key={i}>{i}'s "row"</li>)}<>can't</></ul>);\nconst s = 'kept';\n`;
    const out = maskJsxText(code);
    expectShapePreserved(code, out);
    expect(out).toContain(`<li key={i}>{i}${blank(`'s "row"`)}</li>`);
    expect(out).toContain(`<>${blank("can't")}</>`);
    expect(out).toContain("const s = 'kept';");
  });

  it('closes self-closing elements and resumes code', () => {
    const code = `render(<Foo bar='x' />);\nexpect(a).toBe('it\\'s');\n`;
    expect(maskJsxText(code)).toBe(code);
  });

  it('reads // in JSX text as text, and a comment in a container as a comment', () => {
    const code = `render(<a>https://x.test/it's {/* don't */}</a>);\nconst s = "kept";\n`;
    const out = maskJsxText(code);
    expect(out).toContain(`{/* don't */}`);
    expect(out).toContain('const s = "kept";');
    expectMaskedText(code, "https://x.test/it's ");
  });

  it('does not mistake comparisons or generics for JSX', () => {
    const code = [
      `const ok = a < b && c > d ? 'x' : "y";`,
      `const [v] = useState<string>('a');`,
      `const f = <T,>(x: T) => x;`,
      `const g = <T extends object>(x: T) => x;`,
      `const h = <T = string>(x?: T) => x;`,
      `const k = <A, B>(a: A, b: B) => [a, b];`,
      `const m = <const T,>(x: T) => x;`,
      '',
    ].join('\n');
    expect(maskJsxText(code)).toBe(code);
  });

  it('still masks JSX that follows a generic helper (review repro)', () => {
    const code = `const renderWith = <P extends object>(ui: unknown, _p?: P) => render(ui);\nit('warns', () => {\n  renderWith(<Banner>Don't panic</Banner>);\n  expect(screen.getByRole('alert')).toBeVisible();\n});\n`;
    expectMaskedText(code, "Don't panic");
  });

  it('recovers locally from a type-level generic instead of giving up on the file', () => {
    const code = `type P = { cb: <T>(x: T) => void };\nit('a', () => {\n  render(<p>It's here</p>);\n  expect(1).toBe(1);\n});\n`;
    expectMaskedText(code, "It's here");
  });

  it('sees JSX after a line or block comment', () => {
    expectMaskedText(
      `render(\n  // no messages yet\n  <Inbox>You're all caught up</Inbox>,\n);\n`,
      "You're all caught up",
    );
    expectMaskedText(
      `render(/* empty */ <Inbox>You're done</Inbox>);\n`,
      "You're done",
    );
  });

  it('skips comments inside a tag', () => {
    expectMaskedText(
      `render(<Btn /* it's */ label="x">Don't</Btn>);\nconst s = 'kept';\n`,
      "Don't",
    );
    expectMaskedText(
      `render(\n  <Btn // don't remove\n    label="x"\n  >Can't</Btn>,\n);\n`,
      "Can't",
    );
  });

  it('reads a generic component tag as one tag', () => {
    expectMaskedText(
      `render(<Select<Opt> value="a">It's picked</Select>);\nconst s = 'kept';\n`,
      "It's picked",
    );
  });

  it('skips nested template literals', () => {
    expectMaskedText(
      "const t = `${x ? `it's` : ''}`;\nrender(<p>Don't</p>);\n",
      "Don't",
    );
  });

  it('skips a regex literal containing a quote', () => {
    expectMaskedText(
      `expect(screen.getByText(/you don't have any/i)).toBeVisible();\nrender(<p>It's empty</p>);\n`,
      "It's empty",
    );
  });

  it('returns the source unchanged when an element never closes', () => {
    // Recovery treats each unclosed `<` as an operator in turn; with none left
    // to try, the result is exactly the unmodelled source.
    const code = `const el = <div>it's\nconst s = 'kept';\n`;
    expect(maskJsxText(code)).toBe(code);
  });
});

describe('blankStringContent with jsx', () => {
  it('keeps the assertion after a JSX apostrophe visible', () => {
    const out = blankStringContent(RTL, { jsx: true });
    expectShapePreserved(RTL, out);
    expect(out).toMatch(
      /^\s+expect\(screen\.getByText\("\s+"\)\)\.toBeInTheDocument\(\);$/m,
    );
  });

  it('is byte-identical to the plain mode when jsx is not set', () => {
    expect(blankStringContent(RTL)).toBe(blankStringContent(RTL, {}));
    expect(blankStringContent(RTL, { jsx: false })).toBe(
      blankStringContent(RTL),
    );
  });

  it('still blanks real strings inside JSX attributes and containers', () => {
    const code = `render(<A b="it('x')" c={'test(1)'}>t</A>);\n`;
    const out = blankStringContent(code, { jsx: true });
    expect(out).not.toMatch(/it\(|test\(/);
  });
});

describe('blankStringContent with a path', () => {
  it('turns jsx on for .tsx/.jsx and leaves it off otherwise', () => {
    for (const path of ['a/Button.test.tsx', 'a/Button.test.JSX']) {
      expect(blankStringContent(RTL, { path })).toBe(
        blankStringContent(RTL, { jsx: true }),
      );
    }
    expect(blankStringContent(RTL, { path: 'a/b.test.ts' })).toBe(
      blankStringContent(RTL),
    );
    expect(blankStringContent(RTL, { path: 'a/b.tsx', jsx: false })).toBe(
      blankStringContent(RTL),
    );
  });
});

describe('blankStringContent and regex literals', () => {
  // Pre-existing, but #1180 made it common: RTL writes getByText(/don't/i).
  it('does not open a phantom string at a quote inside a regex', () => {
    const code = `expect(screen.getByText(/you don't have any/i)).toBeVisible();\nconst s = 'kept';\nit('second', () => {});\n`;
    const out = blankStringContent(code);
    expectShapePreserved(code, out);
    expect(out).toContain('expect(screen.getByText(/you don');
    expect(out).toContain(`const s = '${blank('kept')}';`);
    expect(out).toContain(`it('${blank('second')}', () => {});`);
  });

  it('reads a slash after a value as division', () => {
    const code = `const r = total / count; const s = 'a/b'; const t = (x) / 2;\n`;
    const out = blankStringContent(code);
    expect(out).toContain('total / count');
    expect(out).toContain(`'${blank('a/b')}'`);
    expect(out).toContain('(x) / 2');
  });
});
