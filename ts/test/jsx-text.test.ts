/**
 * JSX text is prose, not code (#1180).
 *
 * The string blankers are state machines over raw source, so an apostrophe in
 * JSX children (`<p>It's {n} items</p>`) opened a phantom string literal that
 * ran on and swallowed the next lines -- including the `expect(...)` a scanner
 * needs to see. `maskJsxTextQuotes` replaces only the quote characters inside
 * JSX children text with spaces, preserving length and newlines, so both
 * blankers can run on `.tsx`/`.jsx` exactly as they do on `.ts`/`.js`.
 */
import { describe, expect, it } from 'vitest';

import { maskJsxTextQuotes } from '../src/core/jsx-text.js';
import { blankStringContent } from '../src/core/string-literals.js';

function expectShapePreserved(code: string, out: string): void {
  expect(out).toHaveLength(code.length);
  expect(out.split('\n').map((l) => l.length)).toEqual(
    code.split('\n').map((l) => l.length),
  );
}

const RTL = `import { render, screen } from '@testing-library/react';
import { Button } from './Button';

it("shows the label", () => {
  render(<Button label="Don't stop" onClick={() => {}}><p>It's {count} items</p></Button>);
  expect(screen.getByText("It's 3 items")).toBeInTheDocument();
});
`;

describe('maskJsxTextQuotes', () => {
  it('masks quotes in JSX children text and nothing else', () => {
    const out = maskJsxTextQuotes(RTL);
    expectShapePreserved(RTL, out);
    expect(out).toContain('<p>It s {count} items</p>');
    // An attribute string is a real string and keeps its quotes.
    expect(out).toContain('label="Don\'t stop"');
    // Code after the element is untouched.
    expect(out).toContain('expect(screen.getByText("It\'s 3 items"))');
  });

  it('handles nested elements, expression containers and fragments', () => {
    const code = `render(<ul>{items.map((i) => <li key={i}>{i}'s "row"</li>)}<>can't</></ul>);\nconst s = 'kept';\n`;
    const out = maskJsxTextQuotes(code);
    expectShapePreserved(code, out);
    expect(out).toContain(`<li key={i}>{i} s  row </li>`);
    expect(out).toContain('<>can t</>');
    expect(out).toContain("const s = 'kept';");
  });

  it('closes self-closing elements and resumes code', () => {
    const code = `render(<Foo bar='x' />);\nexpect(a).toBe('it\\'s');\n`;
    expect(maskJsxTextQuotes(code)).toBe(code);
  });

  it('reads // in JSX text as text, and comments in a container as comments', () => {
    const code = `render(<a>https://x.test/it's {/* don't */}</a>);\nconst s = "kept";\n`;
    const out = maskJsxTextQuotes(code);
    expectShapePreserved(code, out);
    expect(out).toContain("<a>https://x.test/it s {/* don't */}</a>");
    expect(out).toContain('const s = "kept";');
  });

  it('does not mistake comparisons or generics for JSX', () => {
    const code = `const ok = a < b && c > d ? 'x' : "y";\nconst [v] = useState<string>('a');\nconst f = <T,>(x: T) => x;\n`;
    expect(maskJsxTextQuotes(code)).toBe(code);
  });

  it('returns the source unchanged when an element never closes', () => {
    // A misdetection must never be worse than not modelling JSX at all.
    const code = `const el = <div>it's\nconst s = 'kept';\n`;
    expect(maskJsxTextQuotes(code)).toBe(code);
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
    // .ts/.js callers never pass jsx, so their behaviour is pinned here.
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
