// Unit suite for the skills' JSX children-text masker (#1188).
//
// agents/skills/lib/jsx-text.mjs is a self-contained port of the engine's
// ts/src/core/jsx-text.ts + js-literals.ts (#1180): skills cannot import the
// engine at runtime, so the cases below mirror ts/test/jsx-text.test.ts. One
// deliberate difference: a `\r` is kept, not blanked, so a CRLF file splits
// into the same lines before and after masking.

import { describe, it, expect } from 'vitest';

import { isJsxPath, maskJsxText } from '../lib/jsx-text.mjs';

function expectShapePreserved(code: string, out: string): void {
  expect(out).toHaveLength(code.length);
  expect(out.split(/\r\n|\r|\n/).map((l) => l.length)).toEqual(
    code.split(/\r\n|\r|\n/).map((l) => l.length),
  );
}

/** `text` with every non-newline character replaced by a space. */
function blank(text: string): string {
  return text.replace(/[^\r\n]/g, ' ');
}

/** Asserts `text` (which must occur once in `code`) comes out blanked. */
function expectMaskedText(code: string, text: string): void {
  const out = maskJsxText(code);
  expectShapePreserved(code, out);
  const at = code.indexOf(text);
  expect(at).toBeGreaterThanOrEqual(0);
  expect(out.slice(at, at + text.length)).toBe(blank(text));
}

const RTL = `import { render, screen } from '@testing-library/react';

it("shows the label", () => {
  render(<Button label="Don't stop" onClick={() => {}}><p>It's {count} items</p></Button>);
  expect(screen.getByText("It's 3 items")).toBeInTheDocument();
});
`;

describe('isJsxPath', () => {
  it('is true for .tsx/.jsx only', () => {
    expect(isJsxPath('a/B.test.tsx')).toBe(true);
    expect(isJsxPath('a/B.test.JSX')).toBe(true);
    const others = ['a.ts', 'a.js', 'a.mjs', 'a.py', 'tsx', '<text>'];
    for (const p of others) {
      expect(isJsxPath(p)).toBe(false);
    }
  });
});

describe('maskJsxText', () => {
  it('blanks JSX children text, keeping tags, attributes and containers', () => {
    const out = maskJsxText(RTL);
    expectShapePreserved(RTL, out);
    expect(out).toContain(`<p>${blank("It's ")}{count}${blank(' items')}</p>`);
    expect(out).toContain('label="Don\'t stop"');
    expect(out).toContain('expect(screen.getByText("It\'s 3 items"))');
  });

  it('keeps CRLF line breaks intact', () => {
    const code = "render(<p>It's\r\nhere</p>);\r\nconst s = 'kept';\r\n";
    const out = maskJsxText(code);
    expectShapePreserved(code, out);
    expect(out).toBe(
      `render(<p>${blank("It's")}\r\n${blank('here')}</p>);\r\nconst s = 'kept';\r\n`,
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
      `const r = total / count; const q = (x) / 2;`,
      '',
    ].join('\n');
    expect(maskJsxText(code)).toBe(code);
  });

  it('still masks JSX that follows a generic helper', () => {
    const code = `const renderWith = <P extends object>(ui: unknown, _p?: P) => render(ui);\nit('warns', () => {\n  renderWith(<Banner>Don't panic</Banner>);\n});\n`;
    expectMaskedText(code, "Don't panic");
  });

  it('recovers locally from a type-level generic instead of giving up on the file', () => {
    const code = `type P = { cb: <T>(x: T) => void };\nit('a', () => {\n  render(<p>It's here</p>);\n});\n`;
    expectMaskedText(code, "It's here");
  });

  it('sees JSX after a line or block comment, and after return', () => {
    expectMaskedText(
      `render(\n  // no messages yet\n  <Inbox>You're all caught up</Inbox>,\n);\n`,
      "You're all caught up",
    );
    expectMaskedText(
      `render(/* empty */ <Inbox>You're done</Inbox>);\n`,
      "You're done",
    );
    expectMaskedText(`function A() {\n  return <p>It's A</p>;\n}\n`, "It's A");
    expectMaskedText(`const A = () => <p>It's B</p>;\n`, "It's B");
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

  it('skips nested template literals and their comments', () => {
    expectMaskedText(
      "const t = `${x ? `it's` : ''}`;\nrender(<p>Don't</p>);\n",
      "Don't",
    );
    expectMaskedText(
      "const t = `${/* } */ a + {b: 1}.b}`;\nrender(<p>Won't</p>);\n",
      "Won't",
    );
    expectMaskedText("const t = `a\\`b`;\nrender(<p>Shan't</p>);\n", "Shan't");
  });

  it('skips a regex literal containing a quote', () => {
    expectMaskedText(
      `expect(screen.getByText(/you don't [a/b] have/i)).toBeVisible();\nrender(<p>It's empty</p>);\n`,
      "It's empty",
    );
  });

  it('reads an unterminated regex-looking slash as an operator', () => {
    const code = `const a = (/ 2\n);\nrender(<p>It's x</p>);\n`;
    expectMaskedText(code, "It's x");
  });

  it('returns the source unchanged when an element never closes', () => {
    const code = `const el = <div>it's\nconst s = 'kept';\n`;
    expect(maskJsxText(code)).toBe(code);
  });

  it('returns the source unchanged when an unterminated comment or string hides the close', () => {
    for (const code of [
      `render(<p>{/* never closed </p>);\n`,
      `render(<p a="never closed>x</p>);\n`,
      `const s = 'unterminated\nrender(<p>It's</p>);\n`,
    ]) {
      const out = maskJsxText(code);
      expectShapePreserved(code, out);
    }
    expect(maskJsxText(`render(<p>{/* open </p>);\n`)).toBe(
      `render(<p>{/* open </p>);\n`,
    );
  });

  it('blanks prose that would otherwise read as an assertion or a timing value', () => {
    expectMaskedText(
      `it('a', () => {\n  render(<Notice>Your session timeout is 45 minutes, so save as you should.</Notice>);\n});\n`,
      'Your session timeout is 45 minutes, so save as you should.',
    );
  });

  // Review repros on #1193: a closing tag closed ANY open element, so a
  // misread type-level `<T>` was "closed" by a `</b>` inside a later string
  // and every line between came back blanked.
  it('only closes an element with a closing tag of the same name', () => {
    for (const code of [
      `type R = { render: <T>(x: T) => string };\nconst t = Date.now();\nexpect(html).toBe('</b>');\n`,
      'const f = (cb: <T>(x: T) => T) => cb;\nconst t = Date.now();\nconst s = `</p>`;\n',
    ]) {
      expect(maskJsxText(code)).toBe(code);
      expectMaskedText(`${code}render(<p>It's real</p>);\n`, "It's real");
    }
    expectMaskedText(`render(<>it's</p>z</>);\n`, `it's</p>z`);
  });

  it('recovers from more misread `<` than one pass per element allows', () => {
    const generic = 'type P = { cb: <T>(x: T) => void };\n'.repeat(100);
    expectMaskedText(`${generic}render(<p>It's here</p>);\n`, "It's here");
  });
});
