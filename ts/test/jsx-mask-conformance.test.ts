/**
 * Drift guard: the skills' JSX masker must read source exactly as the
 * engine's does (#1188, #1193).
 *
 * `agents/skills/lib/jsx-text.mjs` is a self-contained port of
 * `src/core/jsx-text.ts` + `js-literals.ts` -- skills run without the engine,
 * so they cannot import it. Two copies of a lexer drift silently: a fix
 * landed in one (as the #1193 review fixes had to be, twice) leaves the
 * other reading the same file differently. This suite runs a shared corpus
 * (the union of both unit suites' fixtures) and a seeded fuzz through both
 * and requires identical output.
 *
 * The one intended difference: the skill copy keeps a `\r` inside JSX text
 * (so a CRLF file splits into the same lines before and after masking) where
 * the engine blanks it. Outputs are compared with `\r` normalised to a space.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { isJsxPath, maskJsxText } from '../src/core/jsx-text.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface SkillMasker {
  isJsxPath: (path: string) => boolean;
  maskJsxText: (code: string) => string;
}

const skill = (await import(
  pathToFileURL(join(REPO_ROOT, 'agents/skills/lib/jsx-text.mjs')).href
)) as SkillMasker;

const normalise = (s: string): string => s.replace(/\r/g, ' ');

function expectSameReading(code: string): void {
  const engine = maskJsxText(code);
  const ported = skill.maskJsxText(code);
  expect(ported).toHaveLength(engine.length);
  expect(normalise(ported), JSON.stringify(code)).toBe(normalise(engine));
}

const CORPUS = [
  `import { render, screen } from '@testing-library/react';\n\nit("shows the label", () => {\n  render(<Button label="Don't stop" onClick={() => {}}><p>It's {count} items</p></Button>);\n  expect(screen.getByText("It's 3 items")).toBeInTheDocument();\n});\n`,
  `it('a', () => {\n  render(<Notice>Your session timeout is 45 minutes, so save as you should.</Notice>);\n});\n`,
  "render(<p>It's\r\nhere</p>);\r\nconst s = 'kept';\r\n",
  `render(<ul>{items.map((i) => <li key={i}>{i}'s "row"</li>)}<>can't</></ul>);\nconst s = 'kept';\n`,
  `render(<Foo bar='x' />);\nexpect(a).toBe('it\\'s');\n`,
  `render(<a>https://x.test/it's {/* don't */}</a>);\nconst s = "kept";\n`,
  `const ok = a < b && c > d ? 'x' : "y";\nconst [v] = useState<string>('a');\nconst f = <T,>(x: T) => x;\nconst g = <T extends object>(x: T) => x;\nconst h = <T = string>(x?: T) => x;\nconst k = <A, B>(a: A, b: B) => [a, b];\nconst m = <const T,>(x: T) => x;\n`,
  `const r = total / count; const s = 'a/b'; const t = (x) / 2;\n`,
  `const renderWith = <P extends object>(ui: unknown, _p?: P) => render(ui);\nit('warns', () => {\n  renderWith(<Banner>Don't panic</Banner>);\n  expect(screen.getByRole('alert')).toBeVisible();\n});\n`,
  `type P = { cb: <T>(x: T) => void };\nit('a', () => {\n  render(<p>It's here</p>);\n  expect(1).toBe(1);\n});\n`,
  `render(\n  // no messages yet\n  <Inbox>You're all caught up</Inbox>,\n);\n`,
  `render(/* empty */ <Inbox>You're done</Inbox>);\n`,
  `function A() {\n  return <p>It's A</p>;\n}\nconst B = () => <p>It's B</p>;\n`,
  `render(<Btn /* it's */ label="x">Don't</Btn>);\nconst s = 'kept';\n`,
  `render(\n  <Btn // don't remove\n    label="x"\n  >Can't</Btn>,\n);\n`,
  `render(<Select<Opt> value="a">It's picked</Select>);\nconst s = 'kept';\n`,
  "const t = `${x ? `it's` : ''}`;\nrender(<p>Don't</p>);\n",
  "const t = `${/* } */ a + {b: 1}.b}`;\nrender(<p>Won't</p>);\n",
  "const t = `a\\`b`;\nrender(<p>Shan't</p>);\n",
  `expect(screen.getByText(/you don't [a/b] have/i)).toBeVisible();\nrender(<p>It's empty</p>);\n`,
  `const a = (/ 2\n);\nrender(<p>It's x</p>);\n`,
  `const el = <div>it's\nconst s = 'kept';\n`,
  `render(<p>{/* never closed </p>);\n`,
  `render(<p a="never closed>x</p>);\n`,
  `const s = 'unterminated\nrender(<p>It's</p>);\n`,
  `type R = { render: <T>(x: T) => string };\nit('a', () => {\n  const t = Date.now();\n  expect(html).toBe('</b>');\n});\nrender(<p>It's real</p>);\n`,
  `type R = { render: <T>(x: T) => string };\nconst t = Date.now();\nexpect(html).toBe('</b>');\nrender(<p>It's real</p>);\n`,
  'const f = (cb: <T>(x: T) => T) => cb;\nconst t = Date.now();\nconst s = `</p>`;\n',
  `render(<>it's</p>z</>);\n`,
  `${'type P = { cb: <T>(x: T) => void };\n'.repeat(100)}render(<p>It's here</p>);\n`,
  `render(\n  <label>\n    * Required {Date.now()}\n  </label>,\n);\n`,
];

/** Fragments chosen to hit every branch of the lexer and the masker. */
const TOKENS = [
  'render(',
  ')',
  ';',
  '\n',
  '\r\n',
  ' ',
  '<p>',
  '</p>',
  '<b>',
  '</b>',
  '<>',
  '</>',
  '<A x="1" />',
  '<Select<Opt>>',
  "It's",
  'text',
  '{',
  '}',
  '{x}',
  "/re's/g",
  ' / 2',
  '<T,>(x: T) => x',
  '<T>(',
  'type P = { cb: <T>(x: T) => void };',
  '/* c */',
  "/* it's */",
  '// line\n',
  '`t ${a} u`',
  '`${`n`}`',
  "'</b>'",
  '"</p>"',
  'return ',
  '=> ',
  'a < b',
  'c > d',
  '=',
  ',',
];

/** Deterministic PRNG (mulberry32), so a failure reproduces from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function program(next: () => number): string {
  const length = 1 + Math.floor(next() * 40);
  let out = '';
  for (let k = 0; k < length; k += 1) {
    out += TOKENS[Math.floor(next() * TOKENS.length)];
  }
  return out;
}

describe('skill JSX masker conformance with the engine', () => {
  it('reads every corpus fixture the same way', () => {
    for (const code of CORPUS) expectSameReading(code);
  });

  it('reads 3000 seeded fuzz programs the same way', () => {
    const next = rng(1193);
    for (let n = 0; n < 3000; n += 1) expectSameReading(program(next));
  });

  it('agrees on which paths are JSX', () => {
    const paths = [
      'a.tsx',
      'a.JSX',
      'a.ts',
      'a.js',
      'a.mjs',
      'tsx',
      'a.tsx.bak',
    ];
    for (const path of paths) {
      expect(skill.isJsxPath(path), path).toBe(isJsxPath(path));
    }
  });

  it('differs only where the skill keeps a carriage return', () => {
    const code = "render(<p>It's\r\nhere</p>);\n";
    expect(skill.maskJsxText(code)).not.toBe(maskJsxText(code));
    expectSameReading(code);
  });
});
